import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { classifyShiprocketStatus, parseShiprocketTime, pathTo } from '../src/domain/tracking.js';
import { setIntegrations } from '../src/integrations/index.js';
import { MockRazorpayClient } from '../src/integrations/razorpay/mock.js';
import { MOCK_SHIPROCKET_WEBHOOK_TOKEN, MockShiprocketClient } from '../src/integrations/shiprocket/mock.js';
import { MockWhatsAppClient } from '../src/integrations/whatsapp/mock.js';
import { prisma } from '../src/lib/prisma.js';
import { runAction } from '../src/services/adminOrders.js';
import { runDueJobs } from '../src/services/jobs.js';
import { simulateCustomerPayment } from '../src/services/testTools.js';
import { ensureTrackingPoll } from '../src/services/tracking.js';
import { updateSettings } from '../src/services/settings.js';
import { addressReplyWebhook, cartWebhook, signBody, textWebhook } from './fixtures/whatsapp.js';
import { resetDb, seedProduct } from './helpers.js';

// ── Pure helpers ──────────────────────────────────────────────

describe('Shiprocket status mapping', () => {
  it('maps courier statuses to delivery steps', () => {
    expect(classifyShiprocketStatus('PICKED UP')).toEqual({ kind: 'progress', status: 'SHIPPED' });
    expect(classifyShiprocketStatus('Shipped')).toEqual({ kind: 'progress', status: 'SHIPPED' });
    expect(classifyShiprocketStatus('IN TRANSIT')).toEqual({ kind: 'progress', status: 'IN_TRANSIT' });
    expect(classifyShiprocketStatus('REACHED AT DESTINATION HUB')).toEqual({ kind: 'progress', status: 'IN_TRANSIT' });
    expect(classifyShiprocketStatus('OUT FOR DELIVERY')).toEqual({ kind: 'progress', status: 'OUT_FOR_DELIVERY' });
    expect(classifyShiprocketStatus('DELIVERED')).toEqual({ kind: 'progress', status: 'DELIVERED' });
    expect(classifyShiprocketStatus('UNDELIVERED')).toEqual({ kind: 'attempt_failed' });
    expect(classifyShiprocketStatus('PICKUP SCHEDULED')).toEqual({ kind: 'info' });
    expect(classifyShiprocketStatus('OUT FOR PICKUP')).toEqual({ kind: 'info' });
  });

  it('never treats returns, losses or cancellations as delivered', () => {
    for (const s of ['RTO DELIVERED', 'RTO INITIATED', 'RETURN DELIVERED', 'LOST', 'DAMAGED', 'CANCELED', 'PICKUP EXCEPTION']) {
      expect(classifyShiprocketStatus(s).kind).toBe('exception');
    }
  });

  it('fills in skipped steps without inventing ones that did not happen', () => {
    expect(pathTo('PROCESSING', 'DELIVERED')).toEqual(['SHIPPED', 'DELIVERED']);
    expect(pathTo('PAID', 'SHIPPED')).toEqual(['PROCESSING', 'SHIPPED']);
    expect(pathTo('SHIPPED', 'OUT_FOR_DELIVERY')).toEqual(['OUT_FOR_DELIVERY']);
    expect(pathTo('OUT_FOR_DELIVERY', 'IN_TRANSIT')).toEqual(['IN_TRANSIT']); // failed attempt, back at hub
    expect(pathTo('DELIVERED', 'IN_TRANSIT')).toEqual([]);
    expect(pathTo('IN_TRANSIT', 'SHIPPED')).toEqual([]);
  });

  it('parses Shiprocket timestamps as Indian time', () => {
    expect(parseShiprocketTime('23 05 2026 11:43:52')).toEqual(new Date('2026-05-23T06:13:52Z'));
    expect(parseShiprocketTime('2026-05-23 11:43:52')).toEqual(new Date('2026-05-23T06:13:52Z'));
    expect(parseShiprocketTime('')).toBeNull();
    expect(parseShiprocketTime('nonsense')).toBeNull();
  });
});

// ── Workflow ──────────────────────────────────────────────────

let server: Server;
let baseUrl: string;
let wa: MockWhatsAppClient;
let shiprocket: MockShiprocketClient;
let seq = 0;
let clock = Date.parse('2026-10-01T04:00:00Z');

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

beforeEach(async () => {
  await resetDb();
  await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', pricePaise: 34800, stock: 5 });
  wa = new MockWhatsAppClient();
  shiprocket = new MockShiprocketClient();
  setIntegrations({ whatsapp: wa, razorpay: new MockRazorpayClient(), shiprocket });
});

async function postWhatsApp(body: object) {
  const raw = JSON.stringify(body);
  await fetch(`${baseUrl}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) }, body: raw });
}

/** Shiprocket's tracking webhook payload. Each call moves a fake clock forward. */
function trackingPayload(awb: string, status: string, opts: { orderId?: string; minutesLater?: number; location?: string; isReturn?: boolean } = {}) {
  clock += (opts.minutesLater ?? 60) * 60 * 1000;
  const ist = new Date(clock + 5.5 * HOUR).toISOString(); // shift into IST wall-clock
  const stamp = `${ist.slice(8, 10)} ${ist.slice(5, 7)} ${ist.slice(0, 4)} ${ist.slice(11, 19)}`;
  return {
    awb,
    courier_name: 'Delhivery Surface (mock)',
    current_status: status,
    shipment_status: status,
    current_timestamp: stamp,
    order_id: opts.orderId ?? 'QZ-UNKNOWN',
    sr_order_id: 12345,
    is_return: opts.isReturn ? 1 : 0,
    scans: [{ date: `${ist.slice(0, 10)} ${ist.slice(11, 19)}`, activity: status, location: opts.location ?? 'Pune Hub', 'sr-status-label': status }],
  };
}

async function postTracking(body: object, token = MOCK_SHIPROCKET_WEBHOOK_TOKEN) {
  const res = await fetch(`${baseUrl}/webhooks/tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const order = () => prisma.order.findFirstOrThrow({ include: { shipments: true, customer: true } });
const last = () => wa.sent.at(-1)!;

/** Order paid and shipment created (PROCESSING, AWB assigned). */
async function shippedOrder() {
  await postWhatsApp(cartWebhook(`wamid.C${++seq}`, [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]));
  let o = await order();
  await runAction(o.id, 'approve', { adminId: 'a1', expectedVersion: o.version });
  await postWhatsApp(addressReplyWebhook(`wamid.A${++seq}`, { name: 'Priya Sharma', phone_number: '9876543210', in_pin_code: '411001', house_number: '12B', address: 'MG Road', city: 'Pune', state: 'Maharashtra' }));
  o = await order();
  await runAction(o.id, 'request_payment', { adminId: 'a1', expectedVersion: o.version });
  await simulateCustomerPayment(o.id);
  await runDueJobs();
  o = await order();
  expect(o.status).toBe('PROCESSING');
  return { o, awb: o.shipments[0]!.awb! };
}

describe('tracking webhook', () => {
  it('rejects requests without the Shiprocket token', async () => {
    expect((await postTracking({ awb: 'x', current_status: 'DELIVERED' }, 'wrong')).status).toBe(401);
  });

  it('dispatch → sends the dispatch message with a Track Shipment button', async () => {
    const { o, awb } = await shippedOrder();
    const res = await postTracking(trackingPayload(awb, 'PICKED UP'));
    expect(res.status).toBe(200);

    const after = await order();
    expect(after.status).toBe('SHIPPED');
    expect(after.shipments[0]).toMatchObject({ currentStatus: 'PICKED UP', notifiedMilestones: ['SHIPPED'] });
    expect(last()).toMatchObject({
      kind: 'cta_url',
      content: {
        body: `📦 Your Queziva Order Has Been Dispatched!\n\nOrder ID: ${o.orderNumber}\nCourier: Delhivery Surface (mock)\nAWB: ${awb}\n\nTap below to track your shipment.`,
        buttonText: 'Track Shipment',
        url: `https://shiprocket.co/tracking/${awb}`,
      },
    });
  });

  it('uses the dispatch template (tracking link from the AWB) outside the 24-hour window', async () => {
    const { o, awb } = await shippedOrder();
    await prisma.customer.update({ where: { id: o.customerId }, data: { lastInboundAt: new Date(Date.now() - 30 * HOUR) } });
    await postTracking(trackingPayload(awb, 'SHIPPED'));
    const t = last().content as any;
    expect(t.name).toBe('qz_order_dispatched');
    expect(t.components[0].parameters.map((p: any) => p.text)).toEqual(['Priya', o.orderNumber, 'Delhivery Surface (mock)', awb]);
    expect(t.components[1]).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: awb }] });
  });

  it('follows the order to delivery, notifying only the milestones switched on', async () => {
    const { o, awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'PICKED UP'));
    const afterDispatch = wa.sent.length;

    await postTracking(trackingPayload(awb, 'IN TRANSIT', { location: 'Mumbai Hub' }));
    expect((await order()).status).toBe('IN_TRANSIT');
    expect(wa.sent.length).toBe(afterDispatch); // "in transit" is off by default

    await postTracking(trackingPayload(awb, 'OUT FOR DELIVERY'));
    expect((await order()).status).toBe('OUT_FOR_DELIVERY');
    expect(last()).toMatchObject({ kind: 'cta_url', content: { body: expect.stringContaining('out for delivery today') } });

    await postTracking(trackingPayload(awb, 'DELIVERED'));
    const delivered = await order();
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.deliveredAt).toBeInstanceOf(Date);
    expect((last().content as any).body).toBe(
      `🎉 Your Queziva Order Has Been Delivered!\n\nOrder ID: ${o.orderNumber}\n\nWe hope you love your jewellery! 💎\n\n📹 Please record a continuous unboxing video while opening your parcel. This helps us in case of any issue with the shipment.`,
    );
    expect(delivered.shipments[0]!.notifiedMilestones).toEqual(['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']);

    const history = (await prisma.orderEvent.findMany({ where: { orderId: o.id, type: 'STATUS_CHANGED' }, orderBy: { createdAt: 'asc' } })).map((e) => e.toStatus);
    expect(history.slice(-4)).toEqual(['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
  });

  it('ignores duplicates and older updates that arrive late', async () => {
    const { awb } = await shippedOrder();
    const outForDelivery = trackingPayload(awb, 'OUT FOR DELIVERY');
    await postTracking(outForDelivery);
    const dup = await postTracking(outForDelivery);
    expect(dup.body.result).toBe('duplicate');

    const late = trackingPayload(awb, 'IN TRANSIT', { minutesLater: -300 }); // stamped earlier
    await postTracking(late);
    expect((await order()).status).toBe('OUT_FOR_DELIVERY');
    expect(wa.sent.filter((m) => (m.content as any).body?.includes('out for delivery')).length).toBe(1);
  });

  it('fills in a missed "picked up" when the first update is already "delivered"', async () => {
    const { o, awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'DELIVERED'));
    const statuses = (await prisma.orderEvent.findMany({ where: { orderId: o.id, type: 'STATUS_CHANGED' }, orderBy: { createdAt: 'asc' } })).map((e) => e.toStatus);
    expect(statuses.slice(-2)).toEqual(['SHIPPED', 'DELIVERED']);
  });

  it('accepts courier scans stamped before our own AWB bookkeeping (clock differences)', async () => {
    const { awb } = await shippedOrder();
    clock = Date.now() - 3 * HOUR; // courier timestamps behind the server clock
    await postTracking(trackingPayload(awb, 'PICKED UP'));
    expect((await order()).status).toBe('SHIPPED');
    clock = Date.parse('2026-10-01T04:00:00Z');
  });

  it('sends the dispatch message (with the AWB) when the pickup update was missed', async () => {
    const { awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'IN TRANSIT'));
    const after = await order();
    expect(after.status).toBe('IN_TRANSIT');
    expect(after.shipments[0]!.notifiedMilestones).toEqual(['SHIPPED']);
    expect((last().content as any).body).toContain(`AWB: ${awb}`);
  });

  it('tells the customer about a failed delivery attempt', async () => {
    const { awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'OUT FOR DELIVERY'));
    await postTracking(trackingPayload(awb, 'UNDELIVERED'));
    expect((last().content as any).body).toMatch(/couldn't deliver your order .* today/);
    expect((await order()).status).toBe('OUT_FOR_DELIVERY');
  });

  it('raises an alert (and messages nobody) for returns to origin', async () => {
    const { o, awb } = await shippedOrder();
    const before = wa.sent.length;
    await postTracking(trackingPayload(awb, 'RTO INITIATED'));
    await postTracking(trackingPayload(awb, 'DELIVERED', { isReturn: true }));
    const after = await order();
    expect(after.status).toBe('PROCESSING');
    expect(wa.sent.length).toBe(before);
    const alerts = await prisma.orderEvent.findMany({ where: { orderId: o.id, type: 'ERROR' } });
    // One alert for the return – its further scans are the same problem, not new alerts.
    expect(alerts.map((a) => a.message)).toEqual([expect.stringMatching(/Delivery issue: Return to origin \(courier: RTO INITIATED\)/)]);
  });

  it('finds the order by our order number when the AWB is missing, and accepts unknown shipments quietly', async () => {
    const { o } = await shippedOrder();
    await postTracking({ ...trackingPayload('', 'PICKED UP', { orderId: o.orderNumber! }), awb: undefined });
    expect((await order()).status).toBe('SHIPPED');
    expect((await postTracking(trackingPayload('NOPE123', 'DELIVERED'))).status).toBe(200);
  });
});

describe('notification settings and follow-up', () => {
  it('sends "in transit" once the team switches it on', async () => {
    await updateSettings({ notify: { IN_TRANSIT: true } });
    const { awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'IN TRANSIT', { location: 'Mumbai Hub' }));
    expect(last()).toMatchObject({ kind: 'cta_url', content: { body: expect.stringContaining('last seen at Mumbai Hub') } });
  });

  it('asks for feedback after the delay, then completes the order; replies land in its history', async () => {
    await updateSettings({ feedback: { enabled: true, delayHours: 48 }, instagramHandle: '@queziva.jewels', reviewUrl: 'https://g.page/r/queziva/review' });
    const { o, awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'DELIVERED'));

    await runDueJobs(new Date(Date.now() + 47 * HOUR));
    expect((await order()).status).toBe('DELIVERED');

    await runDueJobs(new Date(Date.now() + 49 * HOUR));
    const done = await order();
    expect(done.status).toBe('COMPLETED');
    expect(last()).toMatchObject({ kind: 'cta_url', content: { buttonText: 'Follow on Instagram', url: 'https://instagram.com/queziva.jewels' } });
    const body = (last().content as any).body as string;
    expect(body).toContain('How are you liking your Queziva jewellery?');
    expect(body).toContain('⭐ Leave us a review: https://g.page/r/queziva/review');
    expect(body).toContain('@queziva.jewels');

    await postWhatsApp(textWebhook(`wamid.R${++seq}`, 'Loved the necklace, thank you!'));
    const reply = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'MESSAGE_RECEIVED' }, orderBy: { createdAt: 'desc' } });
    expect(reply.message).toBe('“Loved the necklace, thank you!”');
  });

  it('completes without messaging when feedback is switched off', async () => {
    await updateSettings({ feedback: { enabled: false, delayHours: 48 } });
    const { awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'DELIVERED'));
    const before = wa.sent.length;
    await runDueJobs(new Date(Date.now() + HOUR));
    expect((await order()).status).toBe('COMPLETED');
    expect(wa.sent.length).toBe(before);
  });

  it('validates settings', async () => {
    await expect(updateSettings({ instagramHandle: 'not a handle!' })).rejects.toThrow();
    await expect(updateSettings({ feedback: { enabled: true, delayHours: 0 } })).rejects.toThrow();
    const s = await updateSettings({ notify: { OUT_FOR_DELIVERY: false } });
    expect(s.notify).toMatchObject({ OUT_FOR_DELIVERY: false, SHIPPED: true });
  });
});

describe('polling and admin actions', () => {
  it('the poll picks up a delivery the webhook missed', async () => {
    const { awb } = await shippedOrder();
    shiprocket.track = async (a: string) => ({
      awb: a,
      currentStatus: 'DELIVERED',
      trackingUrl: `https://shiprocket.co/tracking/${a}`,
      events: [
        { status: 'PICKED UP', location: 'Delhi', at: new Date(Date.now() - 5 * HOUR) },
        { status: 'DELIVERED', location: 'Pune', at: new Date(Date.now() - HOUR) },
      ],
    });
    await prisma.shipment.updateMany({ data: { lastEventAt: new Date(Date.now() - 10 * HOUR) } });
    await ensureTrackingPoll();
    await runDueJobs(new Date(Date.now() + 5 * HOUR));
    expect((await order()).status).toBe('DELIVERED');
    expect(awb).toBeTruthy();
    // and the poll schedules itself again
    expect(await prisma.scheduledJob.count({ where: { type: 'tracking.poll', status: 'PENDING' } })).toBe(1);
  });

  it('admin can refresh tracking and mark an order delivered', async () => {
    const { awb } = await shippedOrder();
    await postTracking(trackingPayload(awb, 'PICKED UP'));
    let o = await order();
    const detail = await import('../src/services/adminOrders.js').then((m) => m.orderDetail(o.id));
    expect(detail.actions.map((a) => a.id)).toEqual(expect.arrayContaining(['refresh_tracking', 'mark_delivered']));

    await runAction(o.id, 'mark_delivered', { adminId: 'a1', expectedVersion: o.version });
    o = await order();
    expect(o.status).toBe('DELIVERED');
    const event = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: o.id, toStatus: 'DELIVERED' } });
    expect(event).toMatchObject({ actor: 'ADMIN', actorRef: 'a1' });
  });
});
