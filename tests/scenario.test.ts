/**
 * The client's acceptance scenario, end to end, through the system's real outside interfaces only:
 * signed WhatsApp webhooks (customer), the admin API with a login cookie (Queziva team),
 * signed Razorpay webhooks (payment) and the Shiprocket tracking webhook (courier).
 *
 *   Customer requests 2 → only 1 available → admin changes to 1 → customer accepts →
 *   shipping calculated → final order generated → native payment → payment verified →
 *   shipment created → dispatched → delivered → feedback → completed
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setIntegrations } from '../src/integrations/index.js';
import { MOCK_RAZORPAY_WEBHOOK_SECRET, MockRazorpayClient } from '../src/integrations/razorpay/mock.js';
import { MOCK_SHIPROCKET_WEBHOOK_TOKEN, MockShiprocketClient } from '../src/integrations/shiprocket/mock.js';
import { MockWhatsAppClient } from '../src/integrations/whatsapp/mock.js';
import { hashPassword, verifyPassword } from '../src/lib/auth.js';
import { hmacSha256Hex } from '../src/lib/signature.js';
import { prisma } from '../src/lib/prisma.js';
import { runDueJobs } from '../src/services/jobs.js';
import { addressReplyWebhook, buttonReplyWebhook, cartWebhook, paymentWebhook, signBody, textWebhook, WA_ID } from './fixtures/whatsapp.js';
import { resetDb, seedProduct } from './helpers.js';

let server: Server;
let base: string;
let cookie: string;
const wa = new MockWhatsAppClient();
const razorpay = new MockRazorpayClient();
const shiprocket = new MockShiprocketClient();

beforeAll(async () => {
  await resetDb();
  setIntegrations({ whatsapp: wa, razorpay, shiprocket });
  await seedProduct(); // Pearl Drop Earrings ₹299 – only 1 in stock
  await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', pricePaise: 34800, stock: 5, weightGrams: 180 });
  await prisma.adminUser.create({ data: { email: 'team@queziva.test', name: 'Queziva Team', passwordHash: await hashPassword('scenario-pass-1') } });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'team@queziva.test', password: 'scenario-pass-1' }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});

afterAll(() => new Promise((r) => server.close(r)));

// ── Outside interfaces ────────────────────────────────────────

let n = 0;
async function whatsapp(body: object) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) }, body: raw });
  expect(res.status).toBe(200);
}

async function razorpayWebhook(body: object) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacSha256Hex(MOCK_RAZORPAY_WEBHOOK_SECRET, raw), 'X-Razorpay-Event-Id': `evt_${++n}` },
    body: raw,
  });
  expect(res.status).toBe(200);
}

async function courier(awb: string, status: string) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + ++n * 60_000).toISOString();
  const res = await fetch(`${base}/webhooks/tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MOCK_SHIPROCKET_WEBHOOK_TOKEN },
    body: JSON.stringify({ awb, current_status: status, current_timestamp: `${d.slice(8, 10)} ${d.slice(5, 7)} ${d.slice(0, 4)} ${d.slice(11, 19)}` }),
  });
  expect(res.status).toBe(200);
}

async function admin(method: string, path: string, body?: object) {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  expect(res.status, JSON.stringify(json)).toBe(200);
  expect(json.warning).toBeUndefined();
  return json;
}

const lastToCustomer = () => wa.sent.filter((m) => m.to === WA_ID).at(-1)!;

// ── The story ─────────────────────────────────────────────────

describe("the client's scenario", () => {
  let orderId: string;
  let o: any;

  it('1. customer sends a cart from the WhatsApp catalogue: earrings × 2 and a necklace', async () => {
    await whatsapp(cartWebhook(`wamid.S${++n}`, [
      { retailerId: 'QZ-EAR-001', quantity: 2, price: 299 },
      { retailerId: 'QZ-NCK-001', quantity: 1, price: 348 },
    ]));
    const list = await admin('GET', '/orders?status=NEW');
    expect(list.total).toBe(1);
    orderId = list.orders[0].id;
    expect(list.orders[0]).toMatchObject({ stockIssue: true, itemsSummary: 'Pearl Drop Earrings × 2, Kundan Choker Necklace × 1' });
    expect((lastToCustomer().content as any).body).toContain('No payment is needed right now');
  });

  it('2. admin reviews: only 1 earring in stock, changes 2 → 1, sends the revised order', async () => {
    o = await admin('GET', `/orders/${orderId}`);
    expect(o.stockProblems[0].message).toBe('Pearl Drop Earrings: 2 requested, only 1 in stock');
    o = await admin('POST', `/orders/${orderId}/actions/start_review`, { expectedVersion: o.version });
    const earrings = o.items.find((i: any) => i.sku === 'QZ-EAR-001');
    o = await admin('PATCH', `/orders/${orderId}/items/${earrings.id}`, { expectedVersion: o.version, quantity: 1 });
    expect(o).toMatchObject({ status: 'MODIFIED', subtotalPaise: 64700 });
    o = await admin('POST', `/orders/${orderId}/actions/approve`, { expectedVersion: o.version });
    expect(o.status).toBe('AWAITING_CUSTOMER_APPROVAL');

    const msg = lastToCustomer();
    expect(msg.kind).toBe('buttons');
    expect((msg.content as any).body).toContain('Pearl Drop Earrings: 2 requested, only 1 available');
    expect((msg.content as any).body).toContain('Updated product total: ₹647');
  });

  it('3. customer accepts the revised order and is asked for the address (no payment yet)', async () => {
    const accept = (lastToCustomer().content as any).buttons[0];
    await whatsapp(buttonReplyWebhook(`wamid.S${++n}`, accept.id, accept.title));
    o = await admin('GET', `/orders/${orderId}`);
    expect(o.status).toBe('AWAITING_ADDRESS');
    expect(lastToCustomer().kind).toBe('address');
    expect(wa.sent.some((m) => m.kind === 'order_details')).toBe(false);
  });

  it('4. customer shares the address → shipping calculated with Shiprocket → final amount for review', async () => {
    await whatsapp(addressReplyWebhook(`wamid.S${++n}`, {
      name: 'Priya Sharma', phone_number: '+91 98765 43210', in_pin_code: '411001',
      house_number: 'Flat 12B', address: 'MG Road, Camp', city: 'Pune', state: 'Maharashtra',
    }));
    o = await admin('GET', `/orders/${orderId}`);
    expect(o).toMatchObject({ status: 'READY_FOR_PAYMENT', subtotalPaise: 64700, shippingPaise: 7000, totalPaise: 71700 });
  });

  it('5. admin sends the payment request → native order_details with Pay Now', async () => {
    o = await admin('POST', `/orders/${orderId}/actions/request_payment`, { expectedVersion: o.version });
    expect(o.status).toBe('PAYMENT_REQUESTED');
    const od = lastToCustomer().content as any;
    expect(lastToCustomer().kind).toBe('order_details');
    expect(od).toMatchObject({ subtotalPaise: 64700, shippingPaise: 7000, totalPaise: 71700 });
  });

  it('6. customer pays in WhatsApp; both webhooks arrive; payment verified once → PAID with QZ order ID', async () => {
    const reference = o.payments[0].referenceId;
    const rp = razorpay.simulatePayment({ amountPaise: 71700, referenceId: reference });
    await whatsapp(paymentWebhook(`wamid.S${++n}`, reference, 'captured', 71700, rp.id));
    await razorpayWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: rp.id, order_id: rp.orderId, amount: 71700, notes: [] } } } });

    o = await admin('GET', `/orders/${orderId}`);
    expect(o.status).toBe('PAID');
    expect(o.orderNumber).toMatch(/^QZ\d{6}001$/);
    expect(o.payments[0]).toMatchObject({ status: 'CAPTURED', razorpayPaymentId: rp.id });
    expect((lastToCustomer().content as any).body).toContain(`Order ID: ${o.orderNumber}\nAmount Paid: ₹717`);
    const stock = (await admin('GET', '/products')).products.map((p: any) => [p.sku, p.stock]);
    expect(stock).toEqual(expect.arrayContaining([['QZ-EAR-001', 0], ['QZ-NCK-001', 4]]));
  });

  it('7. shipment created in Shiprocket automatically (order, AWB, pickup)', async () => {
    await runDueJobs();
    o = await admin('GET', `/orders/${orderId}`);
    expect(o.status).toBe('PROCESSING');
    expect(o.shipments[0]).toMatchObject({ courierName: 'Delhivery Surface (mock)', currentStatus: 'PICKUP SCHEDULED' });
    expect(shiprocket.orders.size).toBe(1);
  });

  it('8. courier picks up → dispatch message with AWB and Track Shipment', async () => {
    const awb = o.shipments[0].awb;
    await courier(awb, 'PICKED UP');
    const msg = lastToCustomer();
    expect(msg.kind).toBe('cta_url');
    expect((msg.content as any).body).toContain(`AWB: ${awb}`);
  });

  it('9. out for delivery → delivered with the unboxing-video request', async () => {
    const awb = o.shipments[0].awb;
    await courier(awb, 'IN TRANSIT');
    await courier(awb, 'OUT FOR DELIVERY');
    await courier(awb, 'DELIVERED');
    o = await admin('GET', `/orders/${orderId}`);
    expect(o.status).toBe('DELIVERED');
    expect((lastToCustomer().content as any).body).toContain('Please record a continuous unboxing video');
  });

  it('10. two days later: feedback + Instagram follow-up, order completed; the reply is kept', async () => {
    await runDueJobs(new Date(Date.now() + 49 * 3600_000));
    o = await admin('GET', `/orders/${orderId}`);
    expect(o.status).toBe('COMPLETED');
    expect(lastToCustomer()).toMatchObject({ kind: 'cta_url', content: { buttonText: 'Follow on Instagram' } });

    await whatsapp(textWebhook(`wamid.S${++n}`, 'The necklace is stunning 😍'));
    o = await admin('GET', `/orders/${orderId}`);
    expect(o.events.at(-1)).toMatchObject({ type: 'MESSAGE_RECEIVED', message: '“The necklace is stunning 😍”' });
  });

  it('keeps a complete audit trail of the whole journey', async () => {
    const statuses = o.events.filter((e: any) => e.type === 'STATUS_CHANGED').map((e: any) => e.toStatus);
    expect(statuses).toEqual([
      'PENDING_REVIEW',
      'MODIFIED',
      'AWAITING_CUSTOMER_APPROVAL',
      'AWAITING_ADDRESS',
      'READY_FOR_PAYMENT',
      'PAYMENT_REQUESTED',
      'PAID',
      'PROCESSING',
      'SHIPPED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'COMPLETED',
    ]);
    const earrings = o.items.find((i: any) => i.sku === 'QZ-EAR-001');
    expect(earrings).toMatchObject({ requestedQuantity: 2, quantity: 1 }); // original request preserved

    const kinds = wa.sent.filter((m) => m.to === WA_ID).map((m) => m.kind);
    expect(kinds).toEqual(['text', 'buttons', 'address', 'text', 'order_details', 'order_status', 'cta_url', 'cta_url', 'text', 'cta_url']);
    expect(await verifyPassword('scenario-pass-1', (await prisma.adminUser.findFirstOrThrow()).passwordHash)).toBe(true);
  });
});

describe('customer simulator API', () => {
  it('drives a customer through the real workflow', async () => {
    const simWa = '919990000001';
    const post = (path: string, body: object) => admin('POST', `/simulator/${path}`, { waId: simWa, ...body });

    let state = await post('cart', { name: 'Sim Customer', items: [{ retailerId: 'QZ-NCK-001', quantity: 1 }] });
    expect(state.order).toMatchObject({ status: 'NEW' });
    expect(state.messages.map((m: any) => m.direction)).toEqual(['INBOUND', 'OUTBOUND']);

    let od = await admin('GET', `/orders/${state.order.id}`);
    await admin('POST', `/orders/${od.id}/actions/approve`, { expectedVersion: od.version });
    state = await post('address', { values: { name: 'Sim Customer', phone_number: '9876500000', in_pin_code: '110045', house_number: '1', address: 'Main Rd', city: 'Delhi', state: 'Delhi' } });
    expect(state.order.status).toBe('READY_FOR_PAYMENT');

    od = await admin('GET', `/orders/${state.order.id}`);
    await admin('POST', `/orders/${od.id}/actions/request_payment`, { expectedVersion: od.version });
    state = await post('pay', { outcome: 'captured' });
    expect(state.order).toMatchObject({ status: 'PROCESSING' });
    expect(state.order.awb).toBeTruthy();

    state = await post('courier', { status: 'DELIVERED' });
    expect(state.order.status).toBe('DELIVERED');
    state = await post('fast-forward', { hours: 49 });
    expect(state.order.status).toBe('COMPLETED');
  });

  it('only accepts simulator numbers', async () => {
    const res = await fetch(`${base}/api/admin/simulator?waId=919876543210`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });
});
