import { beforeEach, describe, expect, it } from 'vitest';
import { MockShiprocketClient } from '../src/integrations/shiprocket/mock.js';
import { prisma } from '../src/lib/prisma.js';
import { listEvents } from '../src/services/audit.js';
import {
  createOrderRequest,
  getOrder,
  recalculateTotals,
  transitionOrder,
} from '../src/services/orders.js';
import { nextOrderNumber } from '../src/services/sequence.js';
import { resetDb, seedProduct } from './helpers.js';

const WA_ID = '919876543210';
const admin = { actor: 'ADMIN' as const, actorRef: 'admin-1' };
const customer = { actor: 'CUSTOMER' as const, actorRef: WA_ID };
const system = { actor: 'SYSTEM' as const };

beforeEach(async () => {
  await resetDb();
  await seedProduct();
});

async function placeEarringsOrder(quantity = 2) {
  return createOrderRequest({
    waId: WA_ID,
    customerName: 'Priya',
    inboundMessageId: `wamid.test-${quantity}-${Math.random()}`,
    items: [{ retailerId: 'QZ-EAR-001', quantity, unitPricePaise: 29900 }],
  });
}

describe('createOrderRequest', () => {
  it('stores the cart as a NEW order with the original quantities and a request number', async () => {
    const order = await placeEarringsOrder(2);

    expect(order.status).toBe('NEW');
    expect(order.requestNumber).toMatch(/^RQ\d{6}001$/);
    expect(order.orderNumber).toBeNull();
    expect(order.items[0]).toMatchObject({ sku: 'QZ-EAR-001', requestedQuantity: 2, quantity: 2 });
    expect(order.subtotalPaise).toBe(59800);
    expect(order.totalPaise).toBe(59800);
  });

  it('is idempotent for a repeated WhatsApp webhook', async () => {
    const input = { waId: WA_ID, inboundMessageId: 'wamid.same', items: [{ retailerId: 'QZ-EAR-001', quantity: 1 }] };
    const first = await createOrderRequest(input);
    const second = await createOrderRequest(input);
    expect(second.id).toBe(first.id);
    expect(await prisma.order.count()).toBe(1);
  });

  it('flags unknown catalogue items and price mismatches for the admin', async () => {
    const order = await createOrderRequest({
      waId: WA_ID,
      items: [
        { retailerId: 'NOT-IN-DB', quantity: 1, unitPricePaise: 5000 },
        { retailerId: 'QZ-EAR-001', quantity: 1, unitPricePaise: 25000 },
      ],
    });
    const errors = (await listEvents(prisma, order.id)).filter((e) => e.type === 'ERROR');
    expect(errors.map((e) => e.message)).toEqual([
      'Unknown catalogue item NOT-IN-DB',
      'Price mismatch for QZ-EAR-001: catalogue 25000, system 29900',
    ]);
  });
});

describe('transitionOrder', () => {
  it('runs the key scenario: 2 requested → 1 in stock → customer accepts → shipping → pay → paid', async () => {
    const created = await placeEarringsOrder(2);
    const itemId = created.items[0]!.id;

    await transitionOrder(created.id, 'PENDING_REVIEW', admin);

    // Admin reduces quantity 2 → 1 (the Phase 3 edit endpoint will wrap this)
    await prisma.orderItem.update({ where: { id: itemId }, data: { quantity: 1 } });
    await recalculateTotals(prisma, created.id, admin);

    // Admin cannot skip customer approval once the order is modified
    await expect(transitionOrder(created.id, 'AWAITING_ADDRESS', admin)).rejects.toThrow(/customer approval/);

    await transitionOrder(created.id, 'MODIFIED', admin);
    await transitionOrder(created.id, 'AWAITING_CUSTOMER_APPROVAL', admin);
    await transitionOrder(created.id, 'AWAITING_ADDRESS', customer);

    // No payment before address + shipping calculation
    await expect(transitionOrder(created.id, 'READY_FOR_PAYMENT', system)).rejects.toThrow(/address is incomplete/);

    await prisma.order.update({
      where: { id: created.id },
      data: {
        shipName: 'Priya Sharma',
        shipPhone: '9876543210',
        shipHouse: 'Flat 12B',
        shipStreet: 'MG Road',
        shipCity: 'Pune',
        shipState: 'Maharashtra',
        shipPincode: '411001',
      },
    });
    await expect(transitionOrder(created.id, 'READY_FOR_PAYMENT', system)).rejects.toThrow(/shipping has not been calculated/);

    const [cheapest] = await new MockShiprocketClient().getRates({
      pickupPincode: '110001',
      deliveryPincode: '411001',
      weightKg: 0.06,
      lengthCm: 8,
      breadthCm: 8,
      heightCm: 4,
      declaredValuePaise: 29900,
      cod: false,
    });
    await prisma.order.update({
      where: { id: created.id },
      data: {
        shippingPaise: cheapest!.ratePaise,
        shippingCourierId: cheapest!.courierId,
        shippingCourierName: cheapest!.courierName,
        shippingQuotedAt: new Date(),
      },
    });
    await recalculateTotals(prisma, created.id, system);

    await transitionOrder(created.id, 'READY_FOR_PAYMENT', system);
    const ready = await getOrder(prisma, created.id);
    expect(ready.subtotalPaise).toBe(29900);
    expect(ready.totalPaise).toBe(29900 + 7000);

    await transitionOrder(created.id, 'PAYMENT_REQUESTED', admin);

    // Webhook alone is not enough – a verified, full-amount payment must exist
    await expect(transitionOrder(created.id, 'PAID', system)).rejects.toThrow(/no verified payment/);
    await prisma.payment.create({
      data: {
        orderId: created.id,
        referenceId: ready.requestNumber,
        razorpayPaymentId: 'pay_TEST1',
        amountPaise: ready.totalPaise,
        status: 'CAPTURED',
        verifiedAt: new Date(),
      },
    });

    const paid = await transitionOrder(created.id, 'PAID', system);
    expect(paid.status).toBe('PAID');
    expect(paid.orderNumber).toMatch(/^QZ\d{6}001$/);
    expect(paid.paidAt).toBeInstanceOf(Date);

    // Original request is preserved for audit
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({ requestedQuantity: 2, quantity: 1 });

    const trail = (await listEvents(prisma, created.id)).filter((e) => e.type === 'STATUS_CHANGED');
    expect(trail.map((e) => e.toStatus)).toEqual([
      'PENDING_REVIEW',
      'MODIFIED',
      'AWAITING_CUSTOMER_APPROVAL',
      'AWAITING_ADDRESS',
      'READY_FOR_PAYMENT',
      'PAYMENT_REQUESTED',
      'PAID',
    ]);
  });

  it('lets admin approve an unmodified order directly', async () => {
    const order = await placeEarringsOrder(1);
    const approved = await transitionOrder(order.id, 'AWAITING_ADDRESS', admin);
    expect(approved.status).toBe('AWAITING_ADDRESS');
    expect(approved.approvedAt).toBeInstanceOf(Date);
  });

  it('refuses to send an unchanged order for customer approval', async () => {
    const order = await placeEarringsOrder(1);
    await transitionOrder(order.id, 'PENDING_REVIEW', admin);
    await expect(transitionOrder(order.id, 'MODIFIED', admin)).resolves.toBeTruthy();
    await expect(transitionOrder(order.id, 'AWAITING_CUSTOMER_APPROVAL', admin)).rejects.toThrow(/unchanged/);
  });

  it('rejects transitions the actor is not allowed to make', async () => {
    const order = await placeEarringsOrder(1);
    await expect(transitionOrder(order.id, 'AWAITING_ADDRESS', customer)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('rejects a stale admin update (optimistic locking)', async () => {
    const order = await placeEarringsOrder(1);
    await transitionOrder(order.id, 'PENDING_REVIEW', admin, prisma);
    await expect(
      transitionOrder(order.id, 'CANCELLED', { ...admin, expectedVersion: order.version }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('records the cancel reason', async () => {
    const order = await placeEarringsOrder(1);
    const cancelled = await transitionOrder(order.id, 'CANCELLED', { ...customer, reason: 'Customer declined' });
    expect(cancelled.cancelReason).toBe('Customer declined');
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    await expect(transitionOrder(order.id, 'PENDING_REVIEW', admin)).rejects.toThrow();
  });

  it('joins an outer transaction and rolls back with it', async () => {
    const order = await placeEarringsOrder(1);
    await expect(
      prisma.$transaction(async (tx) => {
        await transitionOrder(order.id, 'PENDING_REVIEW', admin, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await getOrder(prisma, order.id)).status).toBe('NEW');
    expect((await listEvents(prisma, order.id)).filter((e) => e.type === 'STATUS_CHANGED')).toHaveLength(0);
  });
});

describe('sequences', () => {
  it('issues consecutive daily order numbers', async () => {
    const at = new Date('2026-09-28T06:00:00Z');
    expect(await nextOrderNumber(prisma, at)).toBe('QZ260928001');
    expect(await nextOrderNumber(prisma, at)).toBe('QZ260928002');
    expect(await nextOrderNumber(prisma, new Date('2026-09-29T06:00:00Z'))).toBe('QZ260929001');
  });
});
