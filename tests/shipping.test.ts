import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildPackage, chooseCourier, customerShippingCharge } from '../src/domain/shipping.js';
import { setIntegrations } from '../src/integrations/index.js';
import { MOCK_API_DOWN_PINCODE, MOCK_UNSERVICEABLE_PINCODE } from '../src/integrations/shiprocket/mock.js';
import type { CourierOption } from '../src/integrations/shiprocket/types.js';
import { MockWhatsAppClient } from '../src/integrations/whatsapp/mock.js';
import { prisma } from '../src/lib/prisma.js';
import { runAction, setDiscount } from '../src/services/adminOrders.js';
import { saveAddressByAdmin } from '../src/services/customerFlow.js';
import { orderPackage, setManualShipping, shippingOptions } from '../src/services/shipping.js';
import { addressReplyWebhook, cartWebhook, signBody } from './fixtures/whatsapp.js';
import { resetDb, seedProduct } from './helpers.js';

// ── Pure rules ────────────────────────────────────────────────

const courier = (id: number, ratePaise: number, etdDays: number | null, extra: Partial<CourierOption> = {}): CourierOption => ({
  courierId: id,
  courierName: `C${id}`,
  ratePaise,
  etdDays,
  rating: null,
  recommended: false,
  ...extra,
});

describe('shipping rules', () => {
  it('builds one parcel: largest footprint, stacked heights, plus packaging', () => {
    expect(
      buildPackage(
        [
          { quantity: 2, weightGrams: 60, lengthCm: 8, breadthCm: 8, heightCm: 4 },
          { quantity: 1, weightGrams: 180, lengthCm: 15, breadthCm: 12, heightCm: 5 },
          { quantity: 0, weightGrams: 999, lengthCm: 99, breadthCm: 99, heightCm: 99 },
        ],
        50,
      ),
    ).toEqual({ weightGrams: 2 * 60 + 180 + 50, lengthCm: 15, breadthCm: 12, heightCm: 13 });
  });

  it('chooses the courier by strategy', () => {
    const options = [courier(1, 6000, 5), courier(2, 5000, 6), courier(3, 9000, 2, { recommended: true }), courier(4, 5000, 4)];
    expect(chooseCourier(options, 'cheapest')?.courierId).toBe(4); // tie on price → faster wins
    expect(chooseCourier(options, 'fastest')?.courierId).toBe(3);
    expect(chooseCourier(options, 'recommended')?.courierId).toBe(3);
    expect(chooseCourier([courier(1, 6000, 5)], 'recommended')?.courierId).toBe(1); // falls back to cheapest
    expect(chooseCourier([], 'cheapest')).toBeUndefined();
  });

  it('works out what the customer pays', () => {
    const rules = { freeAbovePaise: 99900, roundToRupee: true };
    expect(customerShippingCharge(5840, 64700, rules)).toEqual({ chargePaise: 5900, note: null });
    expect(customerShippingCharge(5840, 99900, rules)).toEqual({ chargePaise: 0, note: 'Free shipping on orders of ₹999 or more' });
    expect(customerShippingCharge(5840, 64700, { ...rules, freeAbovePaise: 0, flatRatePaise: 4900 })).toEqual({ chargePaise: 4900, note: 'Flat shipping rate' });
    expect(customerShippingCharge(5840, 64700, { freeAbovePaise: 0, roundToRupee: false }).chargePaise).toBe(5840);
  });
});

// ── Workflow ──────────────────────────────────────────────────

let server: Server;
let baseUrl: string;
let wa: MockWhatsAppClient;
let seq = 0;

const ADDRESS = {
  name: 'Priya Sharma',
  phone_number: '9876543210',
  in_pin_code: '411001',
  house_number: 'Flat 12B',
  address: 'MG Road',
  city: 'Pune',
  state: 'Maharashtra',
};

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

beforeEach(async () => {
  await resetDb();
  await seedProduct({ stock: 5 }); // earrings 60 g, 8×8×4 cm
  await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', pricePaise: 34800, stock: 5, weightGrams: 180, lengthCm: 15, breadthCm: 12, heightCm: 5 });
  wa = new MockWhatsAppClient();
  setIntegrations({ whatsapp: wa });
});

async function post(body: object) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) },
    body: raw,
  });
  expect(res.status).toBe(200);
}

const order = () => prisma.order.findFirstOrThrow({ include: { items: true } });
const lastSent = () => wa.sent.at(-1)!;

/** Earrings + necklace (₹647), approved unchanged, waiting for the address. */
async function awaitingAddress() {
  await post(cartWebhook(`wamid.C${++seq}`, [
    { retailerId: 'QZ-EAR-001', quantity: 1, price: 299 },
    { retailerId: 'QZ-NCK-001', quantity: 1, price: 348 },
  ]));
  const o = await order();
  await runAction(o.id, 'approve', { adminId: 'admin-1', expectedVersion: o.version });
  return order();
}

describe('automatic shipping quote', () => {
  it('quotes as soon as the address arrives and moves the order to final review', async () => {
    const o = await awaitingAddress();
    await post(addressReplyWebhook(`wamid.A${++seq}`, ADDRESS));

    const q = await order();
    // Pune from Delhi pickup = national zone; 60 + 180 + 50 g packaging = 290 g → one slab of ₹70 (mock)
    expect(q).toMatchObject({
      status: 'READY_FOR_PAYMENT',
      shippingCourierName: 'Delhivery Surface (mock)',
      shippingCourierId: 101,
      shippingCostPaise: 7000,
      shippingPaise: 7000,
      packageWeightGrams: 290,
      subtotalPaise: 64700,
      totalPaise: 64700 + 7000, // GST included in prices (test config)
    });
    expect(q.shippingQuotedAt).toBeInstanceOf(Date);

    const events = await prisma.orderEvent.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } });
    const quote = events.find((e) => e.type === 'SHIPPING_QUOTED')!;
    expect(quote.message).toBe('Delhivery Surface (mock), 6 days: customer pays ₹70 (courier cost ₹70)');
    expect(events.filter((e) => e.type === 'STATUS_CHANGED').at(-1)).toMatchObject({ actor: 'SYSTEM', toStatus: 'READY_FOR_PAYMENT' });

    // Customer is told the address was saved; no payment request yet (admin reviews first)
    expect(lastSent().kind).toBe('text');
    expect((lastSent().content as any).body).toContain("We've saved your delivery address");
    expect(wa.sent.some((m) => m.kind === 'order_details')).toBe(false);
  });

  it('asks for another address when no courier delivers to the pincode', async () => {
    await awaitingAddress();
    await post(addressReplyWebhook(`wamid.A${++seq}`, { ...ADDRESS, in_pin_code: MOCK_UNSERVICEABLE_PINCODE }));

    const q = await order();
    expect(q.status).toBe('AWAITING_ADDRESS');
    expect(q.shipPincode).toBeNull(); // counts as "no address yet" again
    expect(q.shipCity).toBe('Pune'); // rest kept for reference
    const m = lastSent();
    expect(m.kind).toBe('address');
    expect((m.content as any).body).toContain(`don't deliver to pincode ${MOCK_UNSERVICEABLE_PINCODE}`);
    expect((m.content as any).validationErrors).toEqual({ in_pin_code: 'We cannot deliver to this pincode yet' });
    expect((m.content as any).prefill).toMatchObject({ inPinCode: MOCK_UNSERVICEABLE_PINCODE, city: 'Pune', houseNumber: 'Flat 12B' });
    expect(wa.sent.some((x) => (x.content as any).body?.includes("We've saved"))).toBe(false);
    expect(await prisma.scheduledJob.count({ where: { status: 'PENDING', type: 'address.timeout' } })).toBe(1);

    // A deliverable address then goes through
    await post(addressReplyWebhook(`wamid.A${++seq}`, ADDRESS));
    expect((await order()).status).toBe('READY_FOR_PAYMENT');
  });

  it('keeps the address when Shiprocket is down and lets the admin retry', async () => {
    const o = await awaitingAddress();
    const saved = await saveAddressByAdmin(o.id, { name: 'Priya', phone: '9876543210', house: '12B', street: 'MG Road', city: 'Pune', state: 'MH', pincode: MOCK_API_DOWN_PINCODE }, 'admin-1', o.version);
    expect(saved.warning).toMatch(/Shiprocket is not responding/);

    const stuck = await order();
    expect(stuck).toMatchObject({ status: 'AWAITING_ADDRESS', shipPincode: MOCK_API_DOWN_PINCODE, shippingQuotedAt: null });
    const detail = await import('../src/services/adminOrders.js').then((m) => m.orderDetail(o.id));
    expect(detail.actions.map((a) => a.id)).toContain('quote_shipping');

    const retry = await runAction(o.id, 'quote_shipping', { adminId: 'admin-1', expectedVersion: stuck.version });
    expect(retry.warning).toMatch(/not responding/);
  });

  it('admin "Calculate shipping" quotes an order that has an address but no quote yet', async () => {
    const o = await awaitingAddress();
    // Address stored earlier while Shiprocket was unavailable
    await prisma.order.update({
      where: { id: o.id },
      data: { shipName: 'Ananya Iyer', shipPhone: '9820011223', shipHouse: 'B-402', shipStreet: 'Carter Road', shipCity: 'Mumbai', shipState: 'Maharashtra', shipPincode: '400050' },
    });
    const version = (await order()).version;

    const res = await runAction(o.id, 'quote_shipping', { adminId: 'admin-1', expectedVersion: version });
    expect(res.warning).toBeUndefined();
    const q = await order();
    expect(q).toMatchObject({ status: 'READY_FOR_PAYMENT', shippingPaise: 7000, totalPaise: 64700 + 7000 });
    const moved = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: o.id, toStatus: 'READY_FOR_PAYMENT' } });
    expect(moved).toMatchObject({ actor: 'ADMIN', actorRef: 'admin-1' });
  });

  it('warns the admin (without messaging the customer) about an unserviceable pincode', async () => {
    const o = await awaitingAddress();
    const before = wa.sent.length;
    const saved = await saveAddressByAdmin(o.id, { name: 'Priya', phone: '9876543210', house: '12B', street: 'Aberdeen Bazaar', city: 'Port Blair', state: 'Andaman', pincode: MOCK_UNSERVICEABLE_PINCODE }, 'admin-1', o.version);
    expect(saved.warning).toMatch(/no courier delivers to pincode 744101/);
    expect(wa.sent.length).toBe(before);
  });
});

describe('admin final review', () => {
  async function readyForPayment() {
    await awaitingAddress();
    await post(addressReplyWebhook(`wamid.A${++seq}`, ADDRESS));
    return order();
  }

  it('lists live courier options with the customer charge for each', async () => {
    const o = await readyForPayment();
    const opts = await shippingOptions(o.id);
    // earrings 8×8×5 (schema default height) + necklace 15×12×5 → 15×12 footprint, 10 cm stacked
    expect(opts.package).toEqual({ weightGrams: 290, lengthCm: 15, breadthCm: 12, heightCm: 10 });
    expect(opts.options.map((x) => [x.courierId, x.ratePaise, x.customerChargePaise])).toEqual([
      [101, 7000, 7000],
      [102, 11200, 11200],
    ]);
    expect(opts.suggestedCourierId).toBe(101);
  });

  it('switches to a courier the admin picks', async () => {
    const o = await readyForPayment();
    const res = await fetchAdmin('PUT', `/orders/${o.id}/shipping`, { expectedVersion: o.version, courierId: 102 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'READY_FOR_PAYMENT', shippingCourierName: 'Blue Dart Air (mock)', shippingPaise: 11200, totalPaise: 64700 + 11200 });
  });

  it('lets the admin set the shipping charge by hand, and keeps it when the discount changes', async () => {
    const o = await readyForPayment();
    await setManualShipping(o.id, 0, 'Loyal customer – free shipping', 'admin-1', o.version);
    let q = await order();
    expect(q).toMatchObject({ shippingPaise: 0, shippingCostPaise: 7000, shippingNote: 'Set by admin: Loyal customer – free shipping', totalPaise: 64700 });

    await setDiscount(o.id, 5000, 'Festive offer', { adminId: 'admin-1', expectedVersion: q.version });
    q = await order();
    expect(q).toMatchObject({ shippingPaise: 0, discountPaise: 5000, totalPaise: 64700 - 5000 });
  });

  it('re-quotes when the customer sends a new address during final review', async () => {
    const o = await readyForPayment();
    await post(addressReplyWebhook(`wamid.A${++seq}`, { ...ADDRESS, in_pin_code: '110045', city: 'New Delhi', state: 'Delhi' }));
    const q = await order();
    expect(q).toMatchObject({ status: 'READY_FOR_PAYMENT', shipPincode: '110045', shippingPaise: 4000 }); // local zone
    const statuses = (await prisma.orderEvent.findMany({ where: { orderId: o.id, type: 'STATUS_CHANGED' }, orderBy: { createdAt: 'asc' } })).map((e) => e.toStatus);
    expect(statuses.slice(-2)).toEqual(['AWAITING_ADDRESS', 'READY_FOR_PAYMENT']);
  });

  it('refuses shipping changes once the order has moved past the review', async () => {
    const o = await readyForPayment();
    await prisma.order.update({ where: { id: o.id }, data: { status: 'PAYMENT_REQUESTED' } });
    await expect(setManualShipping(o.id, 0, 'x', 'admin-1', o.version)).rejects.toThrow(/before payment is requested/);
  });

  it('computes the parcel from product weights', async () => {
    const o = await readyForPayment();
    expect((await orderPackage(o.id)).weightGrams).toBe(290);
  });
});

// Minimal admin HTTP helper (logs in with a throwaway admin)
async function fetchAdmin(method: string, path: string, body: object) {
  const { hashPassword } = await import('../src/lib/auth.js');
  await prisma.adminUser.upsert({
    where: { email: 'ship@test.local' },
    create: { email: 'ship@test.local', name: 'Ship Admin', passwordHash: await hashPassword('password-123') },
    update: {},
  });
  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ship@test.local', password: 'password-123' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const res = await fetch(`${baseUrl}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
