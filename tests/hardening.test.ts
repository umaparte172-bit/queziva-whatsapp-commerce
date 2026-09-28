/**
 * Regression tests for the issues found in the end-to-end review (races, stuck states, refunds,
 * API limits, configuration). Each test describes the failure it guards against.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { setIntegrations } from '../src/integrations/index.js';
import { MockRazorpayClient } from '../src/integrations/razorpay/mock.js';
import { ShiprocketApiError } from '../src/integrations/shiprocket/live.js';
import { MockShiprocketClient } from '../src/integrations/shiprocket/mock.js';
import { MockWhatsAppClient } from '../src/integrations/whatsapp/mock.js';
import { validateOrderDetails } from '../src/integrations/whatsapp/validate.js';
import { prisma } from '../src/lib/prisma.js';
import { addItem, orderDetail, replaceItem, runAction, setDiscount, setItemQuantity } from '../src/services/adminOrders.js';
import { closeUndelivered } from '../src/services/cancellation.js';
import { createShipment } from '../src/services/fulfilment.js';
import { runDueJobs, scheduleJob } from '../src/services/jobs.js';
import { buildOrderDetails, confirmPayment } from '../src/services/payments.js';
import { updateSettings } from '../src/services/settings.js';
import { quoteShipping, setManualShipping, StaleQuoteError } from '../src/services/shipping.js';
import { fastForward, sendCart, sendText } from '../src/services/simulator.js';
import { ensureTrackingPoll, refreshTracking } from '../src/services/tracking.js';
import { claimWebhook } from '../src/services/webhooks.js';
import { addressReplyWebhook, buttonReplyWebhook, cartWebhook, paymentWebhook, signBody, WA_ID } from './fixtures/whatsapp.js';
import { resetDb, seedProduct } from './helpers.js';

let server: Server;
let base: string;
let wa: MockWhatsAppClient;
let razorpay: MockRazorpayClient;
let shiprocket: MockShiprocketClient;
let n = 0;
const HOUR = 3600_000;
const admin = (version: number, reason?: string) => ({ adminId: 'admin-1', expectedVersion: version, reason });

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(async () => {
  await resetDb();
  await seedProduct({ stock: 5 }); // earrings ₹299
  await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', pricePaise: 34800, stock: 5 });
  await seedProduct({ sku: 'QZ-RNG-001', retailerId: 'QZ-RNG-001', name: 'Solitaire Ring', pricePaise: 19900, stock: 5 });
  wa = new MockWhatsAppClient();
  razorpay = new MockRazorpayClient();
  shiprocket = new MockShiprocketClient();
  setIntegrations({ whatsapp: wa, razorpay, shiprocket });
});

async function postWa(body: object) {
  const raw = JSON.stringify(body);
  return fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) }, body: raw });
}

const order = (id?: string) =>
  prisma.order.findFirstOrThrow({ where: id ? { id } : {}, orderBy: { createdAt: 'desc' }, include: { items: true, payments: true, shipments: true } });
const stock = async (sku: string) => (await prisma.product.findUniqueOrThrow({ where: { sku } })).stock;
const ADDRESS = { name: 'Priya Sharma', phone_number: '9876543210', in_pin_code: '411001', house_number: '12B', address: 'MG Road', city: 'Pune', state: 'Maharashtra' };

async function readyForPayment(items = [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]) {
  await postWa(cartWebhook(`wamid.H${++n}`, items));
  let o = await order();
  await runAction(o.id, 'approve', admin(o.version));
  await postWa(addressReplyWebhook(`wamid.H${++n}`, ADDRESS));
  o = await order();
  expect(o.status).toBe('READY_FOR_PAYMENT');
  return o;
}
async function paymentRequested() {
  const o = await readyForPayment();
  await runAction(o.id, 'request_payment', admin(o.version));
  return order();
}
async function paid() {
  const o = await paymentRequested();
  const rp = razorpay.simulatePayment({ amountPaise: o.payments[0]!.amountPaise, referenceId: o.payments[0]!.referenceId });
  await confirmPayment({ razorpayPaymentId: rp.id, referenceId: o.payments[0]!.referenceId, source: 'whatsapp' });
  return { o: await order(), rp };
}

// ── Configuration ─────────────────────────────────────────────

describe('configuration rules', () => {
  const base = { DATABASE_URL: 'file:./x.db' };
  const secret = { ADMIN_SESSION_SECRET: 'x'.repeat(40) };
  const liveWa = {
    WHATSAPP_MODE: 'live',
    WHATSAPP_ACCESS_TOKEN: 't',
    WHATSAPP_PHONE_NUMBER_ID: 'p',
    WHATSAPP_CATALOG_ID: 'c',
    WHATSAPP_APP_SECRET: 's',
    WHATSAPP_VERIFY_TOKEN: 'v',
    WHATSAPP_PAYMENT_CONFIGURATION: 'cfg',
  };
  const liveRz = { RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' };
  const liveSr = { SHIPROCKET_MODE: 'live', SHIPROCKET_EMAIL: 'e@x.in', SHIPROCKET_PASSWORD: 'p', SHIPROCKET_WEBHOOK_TOKEN: 't', SHIPROCKET_FALLBACK_EMAIL: 'o@x.in' };

  it('refuses live WhatsApp while payments or shipping are still mocked', () => {
    expect(() => parseEnv({ ...base, ...secret, ...liveWa })).toThrow(/WhatsApp can only go live after Razorpay and Shiprocket/);
    expect(() => parseEnv({ ...base, ...secret, ...liveWa, ...liveRz })).toThrow(/WhatsApp can only go live/);
    expect(() => parseEnv({ ...base, ...secret, ...liveWa, ...liveRz, ...liveSr })).not.toThrow();
  });

  it('requires a real session secret as soon as anything is live, not only with NODE_ENV=production', () => {
    expect(() => parseEnv({ ...base, ...liveRz })).toThrow(/ADMIN_SESSION_SECRET/);
    expect(() => parseEnv({ ...base, APP_BASE_URL: 'https://orders.queziva.com' })).toThrow(/ADMIN_SESSION_SECRET/);
    expect(() => parseEnv({ ...base })).not.toThrow(); // plain local development
  });

  it('requires the Shiprocket billing email when Shiprocket is live', () => {
    const { SHIPROCKET_FALLBACK_EMAIL: _omit, ...withoutEmail } = liveSr;
    expect(() => parseEnv({ ...base, ...secret, ...withoutEmail })).toThrow(/SHIPROCKET_FALLBACK_EMAIL/);
  });
});

// ── WhatsApp limits ───────────────────────────────────────────

describe('order card limits (WhatsApp docs)', () => {
  it('shortens long product names to 60 characters and keeps the amounts reconciled', async () => {
    const o = await readyForPayment();
    const item = o.items[0]!;
    await prisma.orderItem.update({ where: { id: item.id }, data: { name: 'Kundan Choker Necklace with Matching Jhumka Earrings and Maang Tikka – Bridal Set' } });
    const od = buildOrderDetails(await order(o.id), 'QZP-RQ1-1', 'Pay now');
    expect(od.items[0]!.name.length).toBe(60);
    expect(() => validateOrderDetails(od)).not.toThrow();
  });

  it('rejects reference ids WhatsApp would refuse (e.g. a colon)', async () => {
    const o = await readyForPayment();
    expect(() => validateOrderDetails(buildOrderDetails(o, 'QZP:RQ1', 'Pay'))).toThrow(/reference_id/);
  });
});

// ── Payments ──────────────────────────────────────────────────

describe('payment confirmation under concurrency', () => {
  it('applies one payment exactly once when all three signals arrive together – nothing refunded', async () => {
    const o = await paymentRequested();
    const rp = razorpay.simulatePayment({ amountPaise: o.payments[0]!.amountPaise, referenceId: o.payments[0]!.referenceId });
    const results = await Promise.all([
      confirmPayment({ razorpayPaymentId: rp.id, referenceId: o.payments[0]!.referenceId, source: 'whatsapp' }),
      confirmPayment({ razorpayPaymentId: rp.id, source: 'razorpay' }),
      confirmPayment({ razorpayPaymentId: rp.id, source: 'razorpay' }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'duplicate', 'paid']);
    const after = await order(o.id);
    expect(after.status).toBe('PAID');
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ status: 'CAPTURED', razorpayPaymentId: rp.id });
    expect(razorpay.refunds).toEqual([]);
    expect(await stock('QZ-NCK-001')).toBe(4);
  });

  it('tells the customer once about a failed attempt reported by both WhatsApp and Razorpay', async () => {
    const o = await paymentRequested();
    const rp = razorpay.simulatePayment({ amountPaise: o.payments[0]!.amountPaise, referenceId: o.payments[0]!.referenceId, outcome: 'failed' });
    await confirmPayment({ razorpayPaymentId: rp.id, referenceId: o.payments[0]!.referenceId, source: 'whatsapp' });
    await confirmPayment({ razorpayPaymentId: rp.id, source: 'razorpay' });
    expect(wa.sent.filter((m) => (m.content as any).body?.includes("didn't go through"))).toHaveLength(1);
  });
});

describe('refunds that fail', () => {
  it('a stray payment whose refund fails is kept as REFUND_FAILED and can be retried – without refunding twice', async () => {
    const { o } = await paid();
    // A second payment on the same (already paid) request; Razorpay processes the refund but the
    // response is lost (timeout) – the classic "did it go through?" case.
    const again = razorpay.simulatePayment({ amountPaise: o.payments[0]!.amountPaise, referenceId: o.payments[0]!.referenceId });
    const realRefund = razorpay.refundPayment.bind(razorpay);
    razorpay.refundPayment = async (id, amount) => {
      await realRefund(id, amount);
      throw new Error('Request timed out');
    };
    await confirmPayment({ razorpayPaymentId: again.id, source: 'razorpay' });
    let stray = (await order(o.id)).payments.find((p) => p.razorpayPaymentId === again.id)!;
    expect(stray.status).toBe('REFUND_FAILED');

    razorpay.refundPayment = realRefund;
    const detail = await orderDetail(o.id);
    expect(detail.actions.map((a) => a.id)).toContain('retry_refund');
    await runAction(o.id, 'retry_refund', admin(detail.version));
    stray = (await order(o.id)).payments.find((p) => p.razorpayPaymentId === again.id)!;
    expect(stray.status).toBe('REFUNDED');
    expect(razorpay.refunds.filter((r) => r.paymentId === again.id)).toHaveLength(1); // never refunded twice
    const history = (await orderDetail(o.id)).events.map((e) => e.message ?? '');
    expect(history.some((m) => /was already refunded at Razorpay – marked as refunded/.test(m))).toBe(true);
    expect(history.filter((m) => /^Refund of .* initiated/.test(m))).toHaveLength(0); // nothing new was refunded
    expect((await order(o.id)).status).toBe('PAID'); // the real order is untouched
  });

  it('cancel & refund: a failed refund still cancels the order and returns stock, then "Retry refund" completes it', async () => {
    const { o } = await paid();
    razorpay.refundPayment = async () => {
      throw new Error('Razorpay is unavailable');
    };
    const res = await runAction(o.id, 'cancel', admin(o.version, 'Customer asked'));
    expect(res.warning).toMatch(/refund failed.*Retry refund/);
    let after = await order(o.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.payments[0]!.status).toBe('REFUND_FAILED');
    expect(await stock('QZ-NCK-001')).toBe(5);

    razorpay.refundPayment = MockRazorpayClient.prototype.refundPayment.bind(razorpay);
    await runAction(o.id, 'retry_refund', admin(after.version));
    after = await order(o.id);
    expect(after.payments[0]!.status).toBe('REFUNDED');
    expect((wa.sent.at(-1)!.content as any).body).toMatch(/refund of ₹4\d\d.* has been initiated/);
  });

  it('refuses cancel & refund while the shipment is being created right now', async () => {
    const { o } = await paid();
    await prisma.scheduledJob.updateMany({ where: { orderId: o.id, type: 'shipment.create' }, data: { status: 'RUNNING', lockedAt: new Date() } });
    await expect(runAction(o.id, 'cancel', admin((await order(o.id)).version, 'x'))).rejects.toThrow(/being created in Shiprocket right now/);
    expect(razorpay.refunds).toEqual([]);
  });
});

// ── Shipping quotes ───────────────────────────────────────────

describe('shipping quotes', () => {
  it('does not save a quote if the order changed while rates were being fetched', async () => {
    const o = await readyForPayment();
    const realRates = shiprocket.getRates.bind(shiprocket);
    shiprocket.getRates = async (r) => {
      // Meanwhile another admin sends the payment request.
      const fresh = await order(o.id);
      await runAction(o.id, 'request_payment', admin(fresh.version));
      return realRates(r);
    };
    await expect(quoteShipping(o.id, { actor: 'ADMIN', actorRef: 'a2', expectedVersion: o.version }, 102)).rejects.toBeInstanceOf(StaleQuoteError);
    const after = await order(o.id);
    expect(after.status).toBe('PAYMENT_REQUESTED');
    expect(after.totalPaise).toBe(after.payments[0]!.amountPaise); // request and order still agree
  });

  it('keeps a manual shipping charge when the customer re-sends their address', async () => {
    const o = await readyForPayment();
    await setManualShipping(o.id, 0, 'VIP customer', 'admin-1', o.version);
    await postWa(addressReplyWebhook(`wamid.H${++n}`, { ...ADDRESS, house_number: '14C' }));
    const after = await order(o.id);
    expect(after).toMatchObject({ status: 'READY_FOR_PAYMENT', shippingPaise: 0, shippingNote: 'Set by admin: VIP customer', shipHouse: '14C' });
  });
});

// ── Fulfilment ────────────────────────────────────────────────

describe('shipment creation', () => {
  it('stops and undoes the Shiprocket order if the order is cancelled while it is being created', async () => {
    const { o } = await paid();
    await prisma.scheduledJob.updateMany({ where: { orderId: o.id }, data: { status: 'CANCELLED' } });
    const realCreate = shiprocket.createOrder.bind(shiprocket);
    shiprocket.createOrder = async (req) => {
      const created = await realCreate(req);
      await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } }); // cancelled meanwhile
      return created;
    };
    expect(await createShipment(o.id)).toBeNull();
    expect(shiprocket.cancelled).toHaveLength(1);
    expect((await order(o.id)).shipments[0]!.awb).toBeNull();
  });

  it('never creates two Shiprocket orders when two runs overlap', async () => {
    const { o } = await paid();
    await prisma.scheduledJob.updateMany({ where: { orderId: o.id }, data: { status: 'CANCELLED' } });
    const realCreate = shiprocket.createOrder.bind(shiprocket);
    shiprocket.createOrder = async (req) => {
      await new Promise((r) => setTimeout(r, 150));
      return realCreate(req);
    };
    const results = await Promise.allSettled([createShipment(o.id), createShipment(o.id)]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(shiprocket.orders.size).toBe(1);
  });

  it('refuses "Retry shipment" while the background job is queued', async () => {
    const { o } = await paid();
    await expect(runAction(o.id, 'create_shipment', admin(o.version))).rejects.toThrow(/already being created/);
  });

  it('does not switch courier on a network error – it retries later with the chosen courier', async () => {
    const { o } = await paid();
    shiprocket.assignAwb = async () => {
      throw new TypeError('fetch failed');
    };
    await runDueJobs();
    const after = await order(o.id);
    expect(after.shipments[0]!.awb).toBeNull();
    expect(after.status).toBe('PAID');
  });

  it('a transient Shiprocket error is retried; a definite refusal of the courier falls back', async () => {
    const { o } = await paid();
    const realAssign = shiprocket.assignAwb.bind(shiprocket);
    shiprocket.assignAwb = async (id, courierId) => {
      if (courierId) throw new ShiprocketApiError('Selected courier not serviceable', 400);
      return realAssign(id, 102);
    };
    await runDueJobs();
    expect((await order(o.id)).status).toBe('PROCESSING');
  });
});

// ── Tracking ──────────────────────────────────────────────────

describe('tracking', () => {
  async function shippedOrder() {
    const { o } = await paid();
    await runDueJobs();
    return order(o.id);
  }
  const courierAt = (msAgo: number) => new Date(Date.now() - msAgo);

  it('"Refresh tracking" records courier time, so a later-arriving earlier scan still counts', async () => {
    const o = await shippedOrder();
    shiprocket.track = async (awb) => ({ awb, currentStatus: 'PICKED UP', trackingUrl: 'https://x', events: [{ status: 'PICKED UP', location: 'Delhi', at: courierAt(5 * HOUR) }] });
    await refreshTracking(o.id, { actor: 'ADMIN', actorRef: 'a1' });
    // Delivered 1h ago, uploaded by the courier only now – must still be applied.
    const res = await fetch(`${base}/webhooks/tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'mock_shiprocket_webhook_token' },
      body: JSON.stringify({ awb: o.shipments[0]!.awb, current_status: 'DELIVERED', current_timestamp: istStamp(courierAt(HOUR)) }),
    });
    expect(res.status).toBe(200);
    expect((await order(o.id)).status).toBe('DELIVERED');
  });

  it('does not repeat the failed-delivery message on every refresh', async () => {
    const o = await shippedOrder();
    const at = courierAt(HOUR);
    shiprocket.track = async (awb) => ({ awb, currentStatus: 'UNDELIVERED', trackingUrl: 'https://x', events: [{ status: 'UNDELIVERED', location: null, at }] });
    for (let i = 0; i < 3; i++) await refreshTracking(o.id, { actor: 'ADMIN', actorRef: 'a1' });
    expect(wa.sent.filter((m) => (m.content as any).body?.includes("couldn't deliver"))).toHaveLength(1);
  });

  it('raises a return-to-origin alert once, and the poll leaves such shipments alone', async () => {
    const o = await shippedOrder();
    let calls = 0;
    let scan = 'RTO INITIATED';
    let scanAt = courierAt(5 * HOUR); // a courier scan has one fixed time
    shiprocket.track = async (awb) => {
      calls++;
      return { awb, currentStatus: scan, trackingUrl: 'https://x', events: [{ status: scan, location: null, at: scanAt }] };
    };
    await refreshTracking(o.id);
    await refreshTracking(o.id); // same scan again
    scan = 'RTO IN TRANSIT'; // a further scan of the same return
    scanAt = courierAt(4 * HOUR);
    await refreshTracking(o.id);
    expect(await prisma.orderEvent.count({ where: { orderId: o.id, type: 'ERROR', message: { contains: 'Return to origin' } } })).toBe(1);

    await ensureTrackingPoll();
    const before = calls;
    await runDueJobs(new Date(Date.now() + 5 * HOUR));
    expect(calls).toBe(before); // not polled again
  });

  it('keeps exactly one tracking poll scheduled, even after a failed run', async () => {
    await ensureTrackingPoll();
    await ensureTrackingPoll();
    expect(await prisma.scheduledJob.count({ where: { type: 'tracking.poll', status: 'PENDING' } })).toBe(1);
    const realFindMany = prisma.shipment.findMany;
    (prisma.shipment as any).findMany = () => Promise.reject(new Error('db hiccup'));
    await runDueJobs(new Date(Date.now() + 5 * HOUR));
    (prisma.shipment as any).findMany = realFindMany;
    expect(await prisma.scheduledJob.count({ where: { type: 'tracking.poll', status: 'PENDING' } })).toBe(1);
  });

  it('completes the order even if the feedback message cannot be sent', async () => {
    const o = await shippedOrder();
    await refreshShipped(o.id);
    await runAction(o.id, 'mark_delivered', admin((await order(o.id)).version));
    wa.sendCtaUrl = async () => {
      throw new Error('Customer blocked the business');
    };
    await runDueJobs(new Date(Date.now() + 49 * HOUR));
    expect((await order(o.id)).status).toBe('COMPLETED');
  });

  it('an admin can close a returned parcel: stock back, refund, customer told', async () => {
    const o = await shippedOrder();
    await refreshShipped(o.id);
    const v = (await order(o.id)).version;
    await closeUndelivered(o.id, { adminId: 'a1', expectedVersion: v, reason: 'RTO – customer refused', restock: true, refund: true });
    const after = await order(o.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.payments[0]!.status).toBe('REFUNDED');
    expect(await stock('QZ-NCK-001')).toBe(5);
    expect((wa.sent.at(-1)!.content as any).body).toMatch(/refund of ₹\d+ for your order QZ/);
  });

  async function refreshShipped(orderId: string) {
    shiprocket.track = async (awb) => ({ awb, currentStatus: 'PICKED UP', trackingUrl: 'https://x', events: [{ status: 'PICKED UP', location: null, at: courierAt(2 * HOUR) }] });
    await refreshTracking(orderId);
    expect((await order(orderId)).status).toBe('SHIPPED');
  }
});

function istStamp(d: Date) {
  const i = new Date(d.getTime() + 5.5 * HOUR).toISOString();
  return `${i.slice(8, 10)} ${i.slice(5, 7)} ${i.slice(0, 4)} ${i.slice(11, 19)}`;
}

// ── Customer flow ─────────────────────────────────────────────

describe('customer flow', () => {
  it('puts an address on the order whose request the customer answered, not just the latest one', async () => {
    // Order A waits for an address; order B (more recently touched) is in final review.
    const a = await (async () => {
      await postWa(cartWebhook(`wamid.H${++n}`, [{ retailerId: 'QZ-RNG-001', quantity: 1, price: 199 }]));
      const o = await order();
      await runAction(o.id, 'approve', admin(o.version));
      return order(o.id);
    })();
    const b = await readyForPayment();
    await setDiscount(b.id, 1000, 'touch', { adminId: 'a1', expectedVersion: b.version });

    const request = await prisma.message.findFirstOrThrow({ where: { orderId: a.id, type: 'address' }, orderBy: { createdAt: 'desc' } });
    const reply = addressReplyWebhook(`wamid.H${++n}`, { ...ADDRESS, house_number: 'A-order' }) as any;
    reply.entry[0].changes[0].value.messages[0].context = { id: request.waMessageId };
    await postWa(reply);

    expect((await order(a.id)).shipHouse).toBe('A-order');
    expect((await order(b.id)).shipHouse).toBe('12B'); // untouched
  });

  it('sends the form back when a correction during final review is invalid', async () => {
    const o = await readyForPayment();
    const before = wa.sent.length;
    await postWa(addressReplyWebhook(`wamid.H${++n}`, { ...ADDRESS, in_pin_code: '12' }));
    expect(wa.sent.length).toBe(before + 1);
    expect(wa.sent.at(-1)).toMatchObject({ kind: 'address', content: { validationErrors: { in_pin_code: expect.any(String) } } });
    expect((await order(o.id)).status).toBe('READY_FOR_PAYMENT');
  });

  it('a discount change while the customer is deciding withdraws that revision', async () => {
    await postWa(cartWebhook(`wamid.H${++n}`, [{ retailerId: 'QZ-NCK-001', quantity: 2, price: 348 }]));
    let o = await order();
    await setItemQuantity(o.id, o.items[0]!.id, 1, admin(o.version));
    o = await order(o.id);
    await runAction(o.id, 'approve', admin(o.version));
    o = await order(o.id);
    await setDiscount(o.id, 5000, 'Sorry for the wait', admin(o.version));
    expect((await order(o.id)).status).toBe('MODIFIED');

    await postWa(buttonReplyWebhook(`wamid.H${++n}`, `qz:accept:${o.id}:${o.approvalRound}`, 'Accept Updated Order'));
    expect((await order(o.id)).status).toBe('MODIFIED'); // the old revision can no longer be accepted
  });

  it('never ends up with two active lines for the same product', async () => {
    await postWa(cartWebhook(`wamid.H${++n}`, [{ retailerId: 'QZ-EAR-001', quantity: 1, price: 299 }]));
    let o = await order();
    const nck = await prisma.product.findUniqueOrThrow({ where: { sku: 'QZ-NCK-001' } });
    const ear = await prisma.product.findUniqueOrThrow({ where: { sku: 'QZ-EAR-001' } });
    await replaceItem(o.id, o.items[0]!.id, nck.id, undefined, admin(o.version));
    o = await order(o.id);
    await replaceItem(o.id, o.items.find((i) => !i.removed)!.id, ear.id, undefined, admin(o.version));
    o = await order(o.id);
    await expect(addItem(o.id, ear.id, 1, admin(o.version))).rejects.toThrow(/already in this order/);
    expect(o.items.filter((i) => i.productId === ear.id && !i.removed)).toHaveLength(1);
  });

  it('does not show a stock warning on paid orders (their units are already deducted)', async () => {
    const { o } = await paid();
    await prisma.product.update({ where: { sku: 'QZ-NCK-001' }, data: { stock: 0 } });
    expect((await orderDetail(o.id)).stockProblems).toEqual([]);
  });
});

// ── Webhooks & simulator ──────────────────────────────────────

describe('webhook delivery', () => {
  it('does not hand out an event that is being processed; retries one that failed', async () => {
    const id = await claimWebhook('test', 'evt-1', 't', {});
    expect(id).toBeTruthy();
    expect(await claimWebhook('test', 'evt-1', 't', {})).toBeNull(); // in flight
    await prisma.webhookEvent.update({ where: { id: id! }, data: { error: 'boom' } });
    expect(await claimWebhook('test', 'evt-1', 't', {})).toBe(id); // failed → retried
  });

  it('answers WhatsApp with an error when an event fails, so Meta redelivers it', async () => {
    const realUpsert = prisma.customer.upsert;
    (prisma.customer as any).upsert = () => Promise.reject(new Error('database hiccup'));
    const res = await postWa(cartWebhook(`wamid.H${++n}`, [{ retailerId: 'QZ-RNG-001', quantity: 1, price: 199 }]));
    (prisma.customer as any).upsert = realUpsert;
    expect(res.status).toBe(500);
  });

  it('WhatsApp payment signal with an unverifiable payment is not acknowledged as done', async () => {
    const o = await paymentRequested();
    const res = await postWa(paymentWebhook(`wamid.H${++n}`, o.payments[0]!.referenceId, 'captured', o.payments[0]!.amountPaise, 'pay_UNKNOWN'));
    expect(res.status).toBe(500);
    expect(WA_ID).toBeTruthy();
  });

  it('simulator "skip ahead" never runs real customers\' jobs early', async () => {
    const real = await paymentRequested(); // WA_ID customer, payment expiry in 48h
    await fastForward(49);
    expect((await order(real.id)).status).toBe('PAYMENT_REQUESTED');
    await scheduleJob(prisma, { type: 'noop', runAt: new Date() });
  });

  it('simulator keeps the customer name on later messages, like real WhatsApp', async () => {
    await sendCart('919990001234', 'Priya', [{ retailerId: 'QZ-RNG-001', quantity: 1 }]);
    await sendText('919990001234', 'hello');
    expect((await prisma.customer.findUnique({ where: { waId: '919990001234' } }))?.name).toBe('Priya');
  });
});
