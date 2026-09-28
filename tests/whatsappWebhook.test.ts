import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setIntegrations } from '../src/integrations/index.js';
import { MOCK_WHATSAPP_VERIFY_TOKEN, MockWhatsAppClient } from '../src/integrations/whatsapp/mock.js';
import { prisma } from '../src/lib/prisma.js';
import { OutsideServiceWindowError, sendToCustomer } from '../src/services/messaging.js';
import {
  buttonReplyWebhook,
  cartWebhook,
  paymentWebhook,
  signBody,
  statusWebhook,
  textWebhook,
  WA_ID,
} from './fixtures/whatsapp.js';
import { resetDb, seedProduct } from './helpers.js';

let server: Server;
let baseUrl: string;
let wa: MockWhatsAppClient;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

beforeEach(async () => {
  await resetDb();
  await seedProduct();
  await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', pricePaise: 34800, stock: 5 });
  wa = new MockWhatsAppClient();
  setIntegrations({ whatsapp: wa });
});

async function post(body: object, signature?: string) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? signBody(raw) },
    body: raw,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

describe('GET /webhooks/whatsapp (subscription handshake)', () => {
  it('echoes the challenge for the right verify token', async () => {
    const res = await fetch(
      `${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${MOCK_WHATSAPP_VERIFY_TOKEN}&hub.challenge=12345`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('rejects a wrong verify token', async () => {
    const res = await fetch(`${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    expect(res.status).toBe(403);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('rejects requests without a valid signature', async () => {
    const body = cartWebhook('wamid.X', [{ retailerId: 'QZ-EAR-001', quantity: 1, price: 299 }]);
    expect((await post(body, 'sha256=deadbeef')).status).toBe(401);
    expect((await post(body, signBody(JSON.stringify(body), 'wrong-secret'))).status).toBe(401);
    expect(await prisma.order.count()).toBe(0);
  });

  it('turns a catalogue cart into a NEW order and acknowledges it without asking for payment', async () => {
    const res = await post(
      cartWebhook('wamid.CART1', [
        { retailerId: 'QZ-EAR-001', quantity: 2, price: 299 },
        { retailerId: 'QZ-NCK-001', quantity: 1, price: 348 },
      ]),
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ processed: 1, duplicates: 0, failed: 0 });

    const order = await prisma.order.findFirstOrThrow({ include: { items: true, customer: true } });
    expect(order.status).toBe('NEW');
    expect(order.inboundMessageId).toBe('wamid.CART1');
    expect(order.subtotalPaise).toBe(2 * 29900 + 34800);
    expect(order.customer).toMatchObject({ waId: WA_ID, name: 'Priya' });
    expect(order.customer.lastInboundAt).toBeInstanceOf(Date);
    expect(order.items.map((i) => [i.sku, i.requestedQuantity])).toEqual([
      ['QZ-EAR-001', 2],
      ['QZ-NCK-001', 1],
    ]);

    // One acknowledgement, a plain text – no order_details / payment request
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]).toMatchObject({ to: WA_ID, kind: 'text' });
    const body = (wa.sent[0]!.content as { body: string }).body;
    expect(body).toContain(order.requestNumber);
    expect(body).toContain('No payment is needed right now');
    expect(wa.readReceipts).toContain('wamid.CART1');

    const messages = await prisma.message.findMany({ orderBy: { createdAt: 'asc' } });
    expect(messages.map((m) => [m.direction, m.type, m.orderId])).toEqual([
      ['INBOUND', 'order', order.id],
      ['OUTBOUND', 'text', order.id],
    ]);
  });

  it('ignores a redelivered webhook (one order, one acknowledgement)', async () => {
    const body = cartWebhook('wamid.DUP', [{ retailerId: 'QZ-EAR-001', quantity: 1, price: 299 }]);
    await post(body);
    const second = await post(body);

    expect(second.json).toMatchObject({ processed: 0, duplicates: 1 });
    expect(await prisma.order.count()).toBe(1);
    expect(wa.sent).toHaveLength(1);
  });

  it('retries an event that failed earlier when Meta redelivers it', async () => {
    const body = cartWebhook('wamid.RETRY', [{ retailerId: 'QZ-EAR-001', quantity: 1, price: 299 }]);
    // First delivery fails part-way through processing (simulated database error).
    const original = prisma.customer.upsert;
    (prisma.customer as any).upsert = () => Promise.reject(new Error('database hiccup'));
    const first = await post(body);
    (prisma.customer as any).upsert = original;

    expect(first.json).toMatchObject({ processed: 0, failed: 1 });
    expect(await prisma.order.count()).toBe(0);
    const stored = await prisma.webhookEvent.findFirstOrThrow();
    expect(stored.error).toBe('database hiccup');

    const second = await post(body);
    expect(second.json).toMatchObject({ processed: 1, duplicates: 0 });
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.webhookEvent.findFirstOrThrow()).processedAt).toBeInstanceOf(Date);
  });

  it('replies to an empty cart instead of creating an order', async () => {
    await post(cartWebhook('wamid.EMPTY', [{ retailerId: 'QZ-EAR-001', quantity: 0, price: 299 }]));
    expect(await prisma.order.count()).toBe(0);
    expect((wa.sent[0]!.content as { body: string }).body).toMatch(/couldn't read any items/);
  });

  it('stores free text and button replies without side effects', async () => {
    await post(textWebhook('wamid.T1', 'Hi, is this available in silver?'));
    await post(buttonReplyWebhook('wamid.B1', 'accept:unknown', 'Accept Updated Order'));
    const inbound = await prisma.message.findMany({ where: { direction: 'INBOUND' } });
    expect(inbound.map((m) => m.type).sort()).toEqual(['button_reply', 'text']);
    expect(wa.sent).toHaveLength(0);
  });

  it('tracks delivery statuses without moving backwards', async () => {
    await post(cartWebhook('wamid.CART2', [{ retailerId: 'QZ-EAR-001', quantity: 1, price: 299 }]));
    const ackId = wa.sent[0]!.messageId;

    await post(statusWebhook(ackId, 'delivered'));
    await post(statusWebhook(ackId, 'read'));
    await post(statusWebhook(ackId, 'delivered')); // late, out-of-order
    expect((await prisma.message.findUniqueOrThrow({ where: { waMessageId: ackId } })).status).toBe('read');
  });

  it('records delivery failures on the order', async () => {
    await post(cartWebhook('wamid.CART3', [{ retailerId: 'QZ-EAR-001', quantity: 1, price: 299 }]));
    const ackId = wa.sent[0]!.messageId;
    await post(statusWebhook(ackId, 'failed', [{ code: 131026, title: 'Message undeliverable' }]));

    const message = await prisma.message.findUniqueOrThrow({ where: { waMessageId: ackId } });
    expect(message.status).toBe('failed');
    const errors = await prisma.orderEvent.findMany({ where: { orderId: message.orderId!, type: 'ERROR' } });
    expect(errors.at(-1)?.message).toMatch(/could not deliver.*131026/);
  });

  it('records WhatsApp payment statuses on the matching order', async () => {
    await post(cartWebhook('wamid.CART4', [{ retailerId: 'QZ-EAR-001', quantity: 1, price: 299 }]));
    const order = await prisma.order.findFirstOrThrow();
    await prisma.payment.create({ data: { orderId: order.id, referenceId: 'QZPAY-TEST-1', amountPaise: 36900 } });

    await post(paymentWebhook('wamid.OD1', 'QZPAY-TEST-1', 'captured', 36900, 'pay_ABC'));

    const event = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: order.id, type: 'PAYMENT_EVENT' } });
    expect(event.message).toBe('WhatsApp payment status: captured');
    // Recording a webhook never marks the order paid – that needs server-side verification.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
  });
});

describe('sendToCustomer', () => {
  it('refuses free-form messages outside the 24-hour window but allows templates', async () => {
    const customer = await prisma.customer.create({
      data: { waId: '919000000001', lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    await expect(sendToCustomer({ customer, message: { kind: 'text', body: 'Hi' } })).rejects.toBeInstanceOf(
      OutsideServiceWindowError,
    );
    await expect(
      sendToCustomer({ customer, message: { kind: 'template', template: { name: 'order_update', language: 'en' } } }),
    ).resolves.toHaveProperty('messageId');
  });

  it('logs failed sends', async () => {
    const customer = await prisma.customer.create({ data: { waId: '919000000002', lastInboundAt: new Date() } });
    await expect(
      sendToCustomer({ customer, message: { kind: 'buttons', body: 'x', buttons: [] } }),
    ).rejects.toThrow();
    const failed = await prisma.message.findFirstOrThrow({ where: { customerId: customer.id } });
    expect(failed.status).toBe('failed');
  });
});
