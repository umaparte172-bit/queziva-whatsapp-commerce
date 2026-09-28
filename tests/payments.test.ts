import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setIntegrations } from '../src/integrations/index.js';
import { MOCK_RAZORPAY_WEBHOOK_SECRET, MockRazorpayClient } from '../src/integrations/razorpay/mock.js';
import { MockShiprocketClient } from '../src/integrations/shiprocket/mock.js';
import { MockWhatsAppClient, type MockSentMessage } from '../src/integrations/whatsapp/mock.js';
import type { OrderDetailsMessage } from '../src/integrations/whatsapp/types.js';
import { validateOrderDetails } from '../src/integrations/whatsapp/validate.js';
import { hmacSha256Hex } from '../src/lib/signature.js';
import { prisma } from '../src/lib/prisma.js';
import { orderDetail, runAction, setDiscount, setItemQuantity } from '../src/services/adminOrders.js';
import { runDueJobs } from '../src/services/jobs.js';
import { confirmPayment, paymentReference } from '../src/services/payments.js';
import { simulateCustomerPayment } from '../src/services/testTools.js';
import {
  addressReplyWebhook,
  buttonReplyWebhook,
  cartWebhook,
  paymentWebhook,
  signBody,
  templateButtonWebhook,
  WA_ID,
} from './fixtures/whatsapp.js';
import { resetDb, seedProduct } from './helpers.js';

let server: Server;
let baseUrl: string;
let wa: MockWhatsAppClient;
let razorpay: MockRazorpayClient;
let shiprocket: MockShiprocketClient;
let seq = 0;

const HOUR = 60 * 60 * 1000;
const admin = (version: number, reason?: string) => ({ adminId: 'admin-1', expectedVersion: version, reason });

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
  await seedProduct(); // earrings ₹299, stock 1
  await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', pricePaise: 34800, stock: 5, weightGrams: 180 });
  wa = new MockWhatsAppClient();
  razorpay = new MockRazorpayClient();
  shiprocket = new MockShiprocketClient();
  setIntegrations({ whatsapp: wa, razorpay, shiprocket });
});

async function postWhatsApp(body: object) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) },
    body: raw,
  });
  expect(res.status).toBe(200);
}

async function postRazorpay(body: object, eventId = `evt_${++seq}`, secret = MOCK_RAZORPAY_WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacSha256Hex(secret, raw), 'X-Razorpay-Event-Id': eventId },
    body: raw,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const order = () => prisma.order.findFirstOrThrow({ include: { items: true, payments: true, shipments: true } });
const last = () => wa.sent.at(-1)!;
const sentOf = (kind: MockSentMessage['kind']) => wa.sent.filter((m) => m.kind === kind);
const stock = async (sku: string) => (await prisma.product.findUniqueOrThrow({ where: { sku } })).stock;

/** The client's scenario up to the final review: 2 earrings requested, 1 in stock, customer accepts, address, shipping. */
async function readyForPayment() {
  await postWhatsApp(cartWebhook(`wamid.C${++seq}`, [
    { retailerId: 'QZ-EAR-001', quantity: 2, price: 299 },
    { retailerId: 'QZ-NCK-001', quantity: 1, price: 348 },
  ]));
  let o = await order();
  await setItemQuantity(o.id, o.items.find((i) => i.sku === 'QZ-EAR-001')!.id, 1, admin(o.version));
  o = await order();
  await runAction(o.id, 'approve', admin(o.version));
  await postWhatsApp(buttonReplyWebhook(`wamid.B${++seq}`, `qz:accept:${o.id}:1`, 'Accept Updated Order'));
  await postWhatsApp(addressReplyWebhook(`wamid.A${++seq}`, ADDRESS));
  o = await order();
  expect(o.status).toBe('READY_FOR_PAYMENT');
  return o;
}

async function paymentRequested() {
  const o = await readyForPayment();
  await runAction(o.id, 'request_payment', admin(o.version));
  return order();
}

/** Customer pays in WhatsApp: Razorpay records the payment and WhatsApp sends its payment status. */
async function customerPays(o: Awaited<ReturnType<typeof order>>, opts: { amountPaise?: number; outcome?: 'captured' | 'failed' } = {}) {
  const payment = o.payments.find((p) => p.status === 'CREATED' || p.status === 'FAILED') ?? o.payments[0]!;
  const rp = razorpay.simulatePayment({ amountPaise: opts.amountPaise ?? payment.amountPaise, referenceId: payment.referenceId, outcome: opts.outcome });
  await postWhatsApp(paymentWebhook(`wamid.P${++seq}`, payment.referenceId, opts.outcome ?? 'captured', rp.amountPaise, rp.id));
  return rp;
}

describe('payment request', () => {
  it('sends a native order_details Pay Now that reconciles exactly', async () => {
    const o = await paymentRequested();
    expect(o.status).toBe('PAYMENT_REQUESTED');
    expect(o.payments).toHaveLength(1);
    expect(o.payments[0]).toMatchObject({ referenceId: paymentReference(o.requestNumber, 1), amountPaise: 29900 + 34800 + 7000, status: 'CREATED' });

    const msg = last();
    expect(msg.kind).toBe('order_details');
    const od = msg.content as OrderDetailsMessage;
    expect(od).toMatchObject({
      referenceId: o.payments[0]!.referenceId,
      subtotalPaise: 64700,
      shippingPaise: 7000,
      shippingDescription: 'Delhivery Surface (mock)',
      taxPaise: 0, // GST-inclusive prices (test config) …
      totalPaise: 71700,
    });
    expect(od.taxDescription).toMatch(/^Inclusive of GST \(₹/); // … so the GST is only described
    expect(od.items).toEqual([
      { retailerId: 'QZ-EAR-001', name: 'Pearl Drop Earrings', amountPaise: 29900, quantity: 1 },
      { retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', amountPaise: 34800, quantity: 1 },
    ]);
    expect(od.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 47 * HOUR);
    expect(() => validateOrderDetails(od)).not.toThrow();
    expect(o.payments[0]!.waMessageId).toBe(msg.messageId);
  });

  it('includes discount and exact totals in order_details', async () => {
    const r = await readyForPayment();
    await setDiscount(r.id, 5000, 'Festive', { adminId: 'admin-1', expectedVersion: r.version });
    const o = await order();
    await runAction(o.id, 'request_payment', admin(o.version));
    const od = last().content as OrderDetailsMessage;
    expect(od).toMatchObject({ discountPaise: 5000, totalPaise: 64700 - 5000 + 7000 });
  });

  it('refuses to request payment before shipping is calculated', async () => {
    await postWhatsApp(cartWebhook(`wamid.C${++seq}`, [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]));
    const o = await order();
    await expect(runAction(o.id, 'request_payment', admin(o.version))).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('uses the payment template after the 24-hour window; tapping it sends the Pay Now', async () => {
    const r = await readyForPayment();
    await prisma.customer.update({ where: { id: r.customerId }, data: { lastInboundAt: new Date(Date.now() - 30 * HOUR) } });
    await runAction(r.id, 'request_payment', admin(r.version));

    expect(last().kind).toBe('template');
    const t = last().content as any;
    expect(t.name).toBe('qz_payment_request');
    expect(t.components[0].parameters.map((p: any) => p.text)).toEqual(['Priya', r.requestNumber, '₹717']);
    expect(t.components[1].parameters[0].payload).toBe(`qz:pay:${r.id}:0`);

    await postWhatsApp(templateButtonWebhook(`wamid.T${++seq}`, `qz:pay:${r.id}:0`, 'Review & Pay'));
    expect(last().kind).toBe('order_details');
  });
});

describe('payment confirmation', () => {
  it('runs the whole scenario: pay → verified → QZ order → stock → confirmation → shipment', async () => {
    const o = await paymentRequested();
    const rp = await customerPays(o);

    const paid = await order();
    expect(paid.status).toBe('PAID');
    expect(paid.orderNumber).toMatch(/^QZ\d{6}001$/);
    expect(paid.payments[0]).toMatchObject({ status: 'CAPTURED', razorpayPaymentId: rp.id, method: 'upi' });
    expect(paid.payments[0]!.verifiedAt).toBeInstanceOf(Date);
    expect(await stock('QZ-EAR-001')).toBe(0);
    expect(await stock('QZ-NCK-001')).toBe(4);

    const confirmation = last();
    expect(confirmation.kind).toBe('order_status');
    expect(confirmation.content).toMatchObject({ referenceId: o.payments[0]!.referenceId, status: 'processing' });
    expect((confirmation.content as any).body).toBe(
      `🎉 Payment Successful\n\nOrder ID: ${paid.orderNumber}\nAmount Paid: ₹717\n\nYour Queziva order has been confirmed. We'll share your tracking details as soon as it ships.`,
    );

    // Shipment job
    await runDueJobs();
    const shipped = await order();
    expect(shipped.status).toBe('PROCESSING');
    expect(shipped.shipments[0]).toMatchObject({ courierId: 101, currentStatus: 'PICKUP SCHEDULED' });
    expect(shipped.shipments[0]!.awb).toMatch(/^MOCK\d{8}$/);
    expect(shipped.shipments[0]!.pickupRequestedAt).toBeInstanceOf(Date);
    const sr = shiprocket.orders.get(shipped.shipments[0]!.shiprocketShipmentId!)!;
    expect(sr).toMatchObject({ orderNumber: paid.orderNumber, paymentMethod: 'Prepaid', subTotalPaise: 64700, shippingPaise: 7000 });
    expect(sr.customer).toMatchObject({ name: 'Priya Sharma', phone: '9876543210', pincode: '411001', address: 'Flat 12B, MG Road' });
    expect(sr.items.map((i) => [i.sku, i.units])).toEqual([['QZ-EAR-001', 1], ['QZ-NCK-001', 1]]);
  });

  it('never trusts the webhook alone: an unknown Razorpay payment id does not mark the order paid', async () => {
    const o = await paymentRequested();
    const raw = JSON.stringify(paymentWebhook(`wamid.P${++seq}`, o.payments[0]!.referenceId, 'captured', o.payments[0]!.amountPaise, 'pay_FORGED123'));
    const res = await fetch(`${baseUrl}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) },
      body: raw,
    });
    expect(res.status).toBe(500); // failed event → Meta redelivers it later
    expect((await order()).status).toBe('PAYMENT_REQUESTED');
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { eventType: 'payment.captured' } })).error).toMatch(/not found/);
  });

  it('waits when Razorpay only shows the payment as authorized', async () => {
    const o = await paymentRequested();
    await customerPays(o, { outcome: 'authorized' as any });
    expect((await order()).status).toBe('PAYMENT_REQUESTED');
  });

  it('applies a payment once even when WhatsApp and Razorpay both report it', async () => {
    const o = await paymentRequested();
    const rp = await customerPays(o);
    const res = await postRazorpay({
      event: 'payment.captured',
      payload: { payment: { entity: { id: rp.id, order_id: rp.orderId, amount: rp.amountPaise, status: 'captured', notes: [] } } },
    });
    expect(res.status).toBe(200);
    expect(await stock('QZ-NCK-001')).toBe(4); // decremented once
    expect(sentOf('order_status')).toHaveLength(1);
    expect((await prisma.orderEvent.findMany({ where: { orderId: o.id, toStatus: 'PAID' } })).length).toBe(1);
  });

  it('confirms from the Razorpay webhook alone, matching via the Razorpay order receipt', async () => {
    const o = await paymentRequested();
    const rp = razorpay.simulatePayment({ amountPaise: o.payments[0]!.amountPaise, referenceId: o.payments[0]!.referenceId });
    const res = await postRazorpay({
      event: 'payment.captured',
      payload: { payment: { entity: { id: rp.id, order_id: rp.orderId, amount: rp.amountPaise, status: 'captured', notes: [] } } },
    });
    expect(res.body.result).toBe('processed');
    expect((await order()).status).toBe('PAID');
  });

  it('rejects Razorpay webhooks with a bad signature', async () => {
    const res = await postRazorpay({ event: 'payment.captured', payload: {} }, 'evt_x', 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('refunds a payment for the wrong amount instead of accepting it', async () => {
    const o = await paymentRequested();
    const rp = await customerPays(o, { amountPaise: 100 });
    const after = await order();
    expect(after.status).toBe('PAYMENT_REQUESTED');
    expect(razorpay.refunds).toEqual([expect.objectContaining({ paymentId: rp.id, amountPaise: 100 })]);
    expect(after.payments[0]).toMatchObject({ status: 'REFUNDED', razorpayPaymentId: rp.id });
    expect((last().content as any).body).toMatch(/started a full refund/);
    const alert = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'ERROR' } });
    expect(alert.message).toMatch(/does not match the request.*refunding it automatically/);
  });

  it('records a failed attempt, tells the customer, and still accepts a later successful one', async () => {
    const o = await paymentRequested();
    await customerPays(o, { outcome: 'failed' });
    let after = await order();
    expect(after.status).toBe('PAYMENT_REQUESTED');
    expect(after.payments[0]).toMatchObject({ status: 'FAILED' });
    expect((last().content as any).body).toMatch(/didn't go through/);

    await customerPays(after);
    after = await order();
    expect(after.status).toBe('PAID');
  });
});

describe('withdrawing, expiry and reminders', () => {
  it('withdraws a payment request, disables the Pay card, and refunds a late payment on it', async () => {
    const o = await paymentRequested();
    await runAction(o.id, 'withdraw_payment', admin(o.version));
    let after = await order();
    expect(after.status).toBe('READY_FOR_PAYMENT');
    expect(after.payments[0]).toMatchObject({ status: 'CANCELLED' });
    expect(last()).toMatchObject({ kind: 'order_status', content: { status: 'canceled', referenceId: o.payments[0]!.referenceId } });

    // Customer pays the old card anyway
    const rp = razorpay.simulatePayment({ amountPaise: o.payments[0]!.amountPaise, referenceId: o.payments[0]!.referenceId });
    await confirmPayment({ razorpayPaymentId: rp.id, referenceId: o.payments[0]!.referenceId, source: 'whatsapp' });
    after = await order();
    expect(after.status).toBe('READY_FOR_PAYMENT');
    expect(razorpay.refunds.map((r) => r.paymentId)).toEqual([rp.id]);

    // A new request gets a new reference
    await runAction(o.id, 'request_payment', admin(after.version));
    after = await order();
    expect(after.payments.map((p) => p.referenceId).sort()).toEqual([paymentReference(o.requestNumber, 1), paymentReference(o.requestNumber, 2)]);
  });

  it('reminds, then cancels an unpaid order and disables its Pay card', async () => {
    const o = await paymentRequested();
    await runDueJobs(new Date(Date.now() + 13 * HOUR));
    expect(last().kind).toBe('order_details');
    expect((last().content as OrderDetailsMessage).body).toMatch(/^Just a reminder/);

    await runDueJobs(new Date(Date.now() + 49 * HOUR));
    const after = await order();
    expect(after).toMatchObject({ status: 'CANCELLED', cancelReason: 'Payment not completed in time' });
    expect(after.payments[0]!.status).toBe('CANCELLED');
    expect(last()).toMatchObject({ kind: 'order_status', content: { status: 'canceled' } });
    expect(await stock('QZ-NCK-001')).toBe(5); // never taken
  });

  it('resend re-sends the same payment request', async () => {
    const o = await paymentRequested();
    await runAction(o.id, 'resend', admin(o.version));
    const sends = sentOf('order_details');
    expect(sends).toHaveLength(2);
    expect((sends[1]!.content as OrderDetailsMessage).referenceId).toBe((sends[0]!.content as OrderDetailsMessage).referenceId);
  });
});

describe('after payment', () => {
  async function paidOrder() {
    const o = await paymentRequested();
    await customerPays(o);
    return order();
  }

  it('cancel & refund: cancels the shipment, refunds in full, restocks and tells the customer', async () => {
    await paidOrder();
    await runDueJobs();
    const o = await order();
    expect(o.status).toBe('PROCESSING');

    const res = await runAction(o.id, 'cancel', admin(o.version, 'Customer changed their mind'));
    expect(res.warning).toBeUndefined();
    const after = await order();
    expect(after.status).toBe('CANCELLED');
    expect(shiprocket.cancelled).toEqual([o.shipments[0]!.shiprocketOrderId]);
    expect(razorpay.refunds).toEqual([expect.objectContaining({ amountPaise: 71700 })]);
    expect(after.payments[0]).toMatchObject({ status: 'REFUNDED', refundedPaise: 71700 });
    expect(await stock('QZ-EAR-001')).toBe(1);
    expect(await stock('QZ-NCK-001')).toBe(5);
    expect((last().content as any).body).toMatch(/refund of ₹717 has been initiated/);
  });

  it('refunds a second payment for an order that is already paid', async () => {
    const o = await paidOrder();
    const again = razorpay.simulatePayment({ amountPaise: o.payments[0]!.amountPaise, referenceId: o.payments[0]!.referenceId });
    await confirmPayment({ razorpayPaymentId: again.id, referenceId: o.payments[0]!.referenceId, source: 'razorpay' });
    expect(razorpay.refunds.map((r) => r.paymentId)).toEqual([again.id]);
    const rows = (await order()).payments;
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.razorpayPaymentId === again.id)).toMatchObject({ status: 'REFUNDED' });

    // …and does not refund it twice when the webhook repeats
    await confirmPayment({ razorpayPaymentId: again.id, referenceId: o.payments[0]!.referenceId, source: 'whatsapp' });
    expect(razorpay.refunds).toHaveLength(1);
  });

  it('retries a failed shipment step without creating a second Shiprocket order', async () => {
    const o = await paidOrder();
    const realAssign = shiprocket.assignAwb.bind(shiprocket);
    shiprocket.assignAwb = async () => {
      throw new Error('Shiprocket wallet balance too low');
    };
    await runDueJobs();
    let after = await order();
    expect(after.status).toBe('PAID');
    expect(after.shipments[0]!.shiprocketOrderId).toBeTruthy();
    expect(after.shipments[0]!.awb).toBeNull();
    const detail = await orderDetail(o.id);
    expect(detail.events.at(-1)!.message).toMatch(/Shipment step failed \(attempt 1 of 3\): Shiprocket wallet balance too low/);

    shiprocket.assignAwb = realAssign;
    await prisma.scheduledJob.updateMany({ data: { status: 'CANCELLED' } }); // admin retries instead of waiting
    const retry = await runAction(o.id, 'create_shipment', admin(after.version));
    expect(retry.warning).toBeUndefined();
    after = await order();
    expect(after.status).toBe('PROCESSING');
    expect(shiprocket.orders.size).toBe(1);
  });

  it('lets Shiprocket pick a courier when the quoted one is no longer available', async () => {
    const { ShiprocketApiError } = await import('../src/integrations/shiprocket/live.js');
    await paidOrder();
    const realAssign = shiprocket.assignAwb.bind(shiprocket);
    shiprocket.assignAwb = async (shipmentId: string, courierId?: number) => {
      if (courierId) throw new ShiprocketApiError('Courier not serviceable', 400);
      return realAssign(shipmentId, 102);
    };
    await runDueJobs();
    const after = await order();
    expect(after.status).toBe('PROCESSING');
    expect(after.shipments[0]!.courierName).toBe('Blue Dart Air (mock)');
  });
});

describe('test mode', () => {
  it('simulates a customer payment through the real verification path', async () => {
    const o = await paymentRequested();
    await simulateCustomerPayment(o.id);
    expect((await order()).status).toBe('PAID');
    expect(WA_ID).toBeTruthy();
  });
});
