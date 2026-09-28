import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setIntegrations } from '../src/integrations/index.js';
import { MockWhatsAppClient, type MockSentMessage } from '../src/integrations/whatsapp/mock.js';
import { prisma } from '../src/lib/prisma.js';
import { runAction, setItemQuantity } from '../src/services/adminOrders.js';
import { buttonId, parseButtonId, saveAddressByAdmin } from '../src/services/customerFlow.js';
import { runDueJobs } from '../src/services/jobs.js';
import {
  addressReplyWebhook,
  buttonReplyWebhook,
  cartWebhook,
  signBody,
  templateButtonWebhook,
  textWebhook,
  WA_ID,
} from './fixtures/whatsapp.js';
import { resetDb, seedProduct } from './helpers.js';

let server: Server;
let baseUrl: string;
let wa: MockWhatsAppClient;
let seq = 0;

const HOUR = 60 * 60 * 1000;
const admin = (version: number) => ({ adminId: 'admin-1', expectedVersion: version });

const VALID_ADDRESS = {
  name: 'Priya Sharma',
  phone_number: '+91 98765 43210',
  in_pin_code: '411001',
  house_number: 'Flat 12B',
  building_name: 'Lotus Heights',
  address: 'MG Road, Camp',
  landmark_area: 'Near City Mall',
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
  await seedProduct(); // earrings, stock 1
  await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker Necklace', pricePaise: 34800, stock: 5 });
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
  return res.json();
}

const id = (prefix: string) => `wamid.${prefix}${++seq}`;
const last = (): MockSentMessage => wa.sent.at(-1)!;
const content = <T = any>(m: MockSentMessage) => m.content as T;
const order = () => prisma.order.findFirstOrThrow({ include: { items: true, customer: true } });
const pendingJobs = async () =>
  (await prisma.scheduledJob.findMany({ where: { status: 'PENDING' }, orderBy: { type: 'asc' } })).map((j) => j.type);

/** Customer orders 2 earrings (only 1 in stock) + 1 necklace; admin reduces earrings to 1 and approves. */
async function revisedOrderSent() {
  await post(cartWebhook(id('CART'), [
    { retailerId: 'QZ-EAR-001', quantity: 2, price: 299 },
    { retailerId: 'QZ-NCK-001', quantity: 1, price: 348 },
  ]));
  let o = await order();
  const earrings = o.items.find((i) => i.sku === 'QZ-EAR-001')!;
  await setItemQuantity(o.id, earrings.id, 1, admin(o.version));
  o = await order();
  await runAction(o.id, 'approve', admin(o.version));
  return order();
}

describe('button ids', () => {
  it('round-trips order id and approval round', () => {
    expect(parseButtonId(buttonId('accept', 'ck123abc', 2))).toEqual({ action: 'accept', orderId: 'ck123abc', round: 2 });
    expect(parseButtonId('accept:unknown')).toBeNull();
    expect(parseButtonId('qz:delete:x:1')).toBeNull();
  });
});

describe('revised order → customer approval', () => {
  it('sends the revised order with Accept / Cancel buttons and starts the timers', async () => {
    const o = await revisedOrderSent();
    expect(o.status).toBe('AWAITING_CUSTOMER_APPROVAL');
    expect(o.approvalRound).toBe(1);

    const msg = last();
    expect(msg.kind).toBe('buttons');
    const c = content(msg);
    expect(c.header).toBe('Order Update – Queziva');
    expect(c.body).toContain('Pearl Drop Earrings: 2 requested, only 1 available');
    expect(c.body).toContain('• Pearl Drop Earrings × 1 — ₹299');
    expect(c.body).toContain('Updated product total: ₹647');
    expect(c.body).toContain('No payment is needed yet');
    expect(c.buttons).toEqual([
      { id: `qz:accept:${o.id}:1`, title: 'Accept Updated Order' },
      { id: `qz:cancel:${o.id}:1`, title: 'Cancel Order' },
    ]);
    expect(await pendingJobs()).toEqual(['approval.reminder', 'approval.timeout']);
  });

  it('customer accepts → asked for the address with name and number prefilled', async () => {
    const o = await revisedOrderSent();
    await post(buttonReplyWebhook(id('BTN'), `qz:accept:${o.id}:1`, 'Accept Updated Order'));

    const after = await order();
    expect(after.status).toBe('AWAITING_ADDRESS');
    expect(last().kind).toBe('address');
    expect(content(last()).body).toContain('Thank you for confirming');
    expect(content(last()).prefill).toEqual({ name: 'Priya', phoneNumber: '9876543210' });
    expect(await pendingJobs()).toEqual(['address.reminder', 'address.timeout']);

    const events = await prisma.orderEvent.findMany({ where: { orderId: o.id, type: 'STATUS_CHANGED' }, orderBy: { createdAt: 'asc' } });
    expect(events.at(-1)).toMatchObject({ actor: 'CUSTOMER', toStatus: 'AWAITING_ADDRESS', message: 'Customer accepted the revised order' });
  });

  it('customer cancels → order cancelled and acknowledged', async () => {
    const o = await revisedOrderSent();
    await post(buttonReplyWebhook(id('BTN'), `qz:cancel:${o.id}:1`, 'Cancel Order'));

    expect((await order()).status).toBe('CANCELLED');
    expect(content(last()).body).toMatch(/has been cancelled/);
    expect(await pendingJobs()).toEqual([]);
  });

  it('rejects a tap on an outdated version and re-sends the latest one', async () => {
    let o = await revisedOrderSent();
    // Admin edits again after sending (withdraws round 1), then sends round 2.
    const necklace = o.items.find((i) => i.sku === 'QZ-NCK-001')!;
    await setItemQuantity(o.id, necklace.id, 2, admin(o.version));
    o = await order();
    expect(o.status).toBe('MODIFIED');

    // Customer taps the old button while the admin is still editing
    await post(buttonReplyWebhook(id('BTN'), `qz:accept:${o.id}:1`, 'Accept Updated Order'));
    expect((await order()).status).toBe('MODIFIED');
    expect(content(last()).body).toMatch(/updated again/);

    await runAction(o.id, 'approve', admin(o.version));
    o = await order();
    expect(o.approvalRound).toBe(2);

    const before = wa.sent.length;
    await post(buttonReplyWebhook(id('BTN'), `qz:accept:${o.id}:1`, 'Accept Updated Order'));
    expect((await order()).status).toBe('AWAITING_CUSTOMER_APPROVAL');
    expect(content(wa.sent[before]!).body).toMatch(/updated again/);
    expect(content(wa.sent[before + 1]!).buttons[0].id).toBe(`qz:accept:${o.id}:2`);

    await post(buttonReplyWebhook(id('BTN'), `qz:accept:${o.id}:2`, 'Accept Updated Order'));
    expect((await order()).status).toBe('AWAITING_ADDRESS');
  });

  it('answers a second tap after accepting without changing anything', async () => {
    const o = await revisedOrderSent();
    await post(buttonReplyWebhook(id('BTN'), `qz:accept:${o.id}:1`, 'Accept Updated Order'));
    await post(buttonReplyWebhook(id('BTN'), `qz:cancel:${o.id}:1`, 'Cancel Order'));
    expect((await order()).status).toBe('AWAITING_ADDRESS');
    expect(content(last()).body).toMatch(/already confirmed/);
  });

  it('ignores button taps from a different customer', async () => {
    const o = await revisedOrderSent();
    const other = buttonReplyWebhook(id('BTN'), `qz:accept:${o.id}:1`, 'Accept Updated Order');
    (other.entry[0]!.changes[0]!.value as any).messages[0].from = '919111111111';
    await post(other);
    expect((await order()).status).toBe('AWAITING_CUSTOMER_APPROVAL');
  });

  it('uses the approved template (with button payloads) after the 24-hour window', async () => {
    await post(cartWebhook(id('CART'), [{ retailerId: 'QZ-EAR-001', quantity: 2, price: 299 }]));
    let o = await order();
    await prisma.customer.update({ where: { id: o.customerId }, data: { lastInboundAt: new Date(Date.now() - 30 * HOUR) } });
    await setItemQuantity(o.id, o.items[0]!.id, 1, admin(o.version));
    o = await order();
    await runAction(o.id, 'approve', admin(o.version));

    const msg = last();
    expect(msg.kind).toBe('template');
    const t = content(msg);
    expect(t.name).toBe('qz_order_update');
    expect(t.components[0].parameters.map((p: any) => p.text)).toEqual([
      'Priya',
      o.requestNumber,
      'Pearl Drop Earrings: 2 requested, only 1 available',
      '₹299',
    ]);
    expect(t.components[1]).toEqual({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: `qz:accept:${o.id}:1` }],
    });

    // Tapping the template button re-opens the window, so the address form can be sent
    await post(templateButtonWebhook(id('TPL'), `qz:accept:${o.id}:1`, 'Accept Updated Order'));
    expect((await order()).status).toBe('AWAITING_ADDRESS');
    expect(last().kind).toBe('address');
  });
});

describe('address collection', () => {
  async function awaitingAddress() {
    await post(cartWebhook(id('CART'), [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]));
    const o = await order();
    await runAction(o.id, 'approve', admin(o.version));
    return order();
  }

  it('approving an unchanged order asks for the address straight away', async () => {
    const o = await awaitingAddress();
    expect(o.status).toBe('AWAITING_ADDRESS');
    expect(last().kind).toBe('address');
    expect(content(last()).body).toContain('is confirmed');
  });

  it('saves a valid address from the WhatsApp form and remembers it for next time', async () => {
    const o = await awaitingAddress();
    await post(addressReplyWebhook(id('ADDR'), VALID_ADDRESS));

    const saved = await order();
    expect(saved).toMatchObject({
      shipName: 'Priya Sharma',
      shipPhone: '9876543210',
      shipHouse: 'Flat 12B, Lotus Heights',
      shipStreet: 'MG Road, Camp',
      shipLandmark: 'Near City Mall',
      shipCity: 'Pune',
      shipState: 'Maharashtra',
      shipPincode: '411001',
    });
    expect(saved.customer.savedAddress).toMatchObject({ pincode: '411001', phone: '9876543210' });
    expect(content(last()).body).toContain("We've saved your delivery address");
    expect(await pendingJobs()).toEqual([]);

    // Next order: the form comes prefilled with the saved address
    await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } });
    await post(cartWebhook(id('CART'), [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]));
    const second = await prisma.order.findFirstOrThrow({ where: { status: 'NEW' } });
    await runAction(second.id, 'approve', admin(second.version));
    expect(content(last()).prefill).toMatchObject({ inPinCode: '411001', houseNumber: 'Flat 12B, Lotus Heights', city: 'Pune' });
  });

  it('re-sends the form with the problems highlighted when details are invalid', async () => {
    await awaitingAddress();
    await post(addressReplyWebhook(id('ADDR'), { ...VALID_ADDRESS, in_pin_code: '41100', phone_number: '12345' }));

    expect((await order()).shipPincode).toBeNull();
    const m = content(last());
    expect(last().kind).toBe('address');
    expect(m.body).toContain('need a quick fix');
    expect(Object.keys(m.validationErrors).sort()).toEqual(['in_pin_code', 'phone_number']);
    expect(m.prefill).toMatchObject({ city: 'Pune', inPinCode: '41100' });
  });

  it('nudges a customer who types instead of using the form, and logs the message on the order', async () => {
    const o = await awaitingAddress();
    await post(textWebhook(id('TXT'), 'Flat 12B, MG Road, Pune 411001'));

    expect(last().kind).toBe('address');
    expect(content(last()).body).toContain('using the form below');
    const received = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'MESSAGE_RECEIVED' } });
    expect(received.message).toBe('“Flat 12B, MG Road, Pune 411001”');
  });

  it('lets admin enter the address, with the same validation', async () => {
    const o = await awaitingAddress();
    const fields = { name: 'Priya Sharma', phone: '09876543210', house: '12B', street: 'MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
    await expect(saveAddressByAdmin(o.id, { ...fields, pincode: 'abc' }, 'admin-1', o.version)).rejects.toThrow(/pincode/);
    await saveAddressByAdmin(o.id, fields, 'admin-1', o.version);
    expect(await order()).toMatchObject({ shipPhone: '9876543210', shipPincode: '411001' });
  });

  it('tells the customer when no order is waiting for an address', async () => {
    await post(addressReplyWebhook(id('ADDR'), VALID_ADDRESS));
    expect(content(last()).body).toMatch(/don't have an order waiting/);
  });
});

describe('reminders and timeouts', () => {
  const later = (h: number) => new Date(Date.now() + h * HOUR);

  it('reminds, then cancels, a revised order the customer never answers', async () => {
    const o = await revisedOrderSent();

    await runDueJobs(later(13));
    expect(last().kind).toBe('buttons');
    expect(content(last()).body).toMatch(/^Just a reminder/);
    expect((await order()).status).toBe('AWAITING_CUSTOMER_APPROVAL');

    // Simulate the time passing for the 24-hour window as well: the customer last wrote 49h ago.
    await prisma.customer.update({ where: { id: o.customerId }, data: { lastInboundAt: new Date(Date.now() - 49 * HOUR) } });
    await runDueJobs(later(49));
    const cancelled = await order();
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'No response to the revised order' });
    // 49h later the 24h window has closed, so the notice goes out as a template
    expect(last().kind).toBe('template');
    expect(content(last()).name).toBe('qz_order_cancelled');
    expect(o.id).toBe(cancelled.id);
  });

  it('does nothing when the customer already answered', async () => {
    const o = await revisedOrderSent();
    await post(buttonReplyWebhook(id('BTN'), `qz:accept:${o.id}:1`, 'Accept Updated Order'));
    await post(addressReplyWebhook(id('ADDR'), VALID_ADDRESS));
    const before = wa.sent.length;

    await runDueJobs(later(100));
    expect(wa.sent.length).toBe(before);
    expect((await order()).status).toBe('READY_FOR_PAYMENT'); // address → shipping quoted automatically
  });

  it('skips stale jobs even if they were not cancelled', async () => {
    const o = await revisedOrderSent();
    await prisma.order.update({ where: { id: o.id }, data: { approvalRound: 5 } });
    await runDueJobs(later(49));
    expect((await order()).status).toBe('AWAITING_CUSTOMER_APPROVAL');
  });

  it('cancels an order when no address arrives', async () => {
    await post(cartWebhook(id('CART'), [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]));
    const o = await order();
    await runAction(o.id, 'approve', admin(o.version));

    const before = wa.sent.length;
    await runDueJobs(later(13));
    expect(wa.sent.length).toBe(before + 1);
    expect(content(last()).body).toMatch(/^Just a reminder – we still need your delivery address/);
    await runDueJobs(later(73));
    expect((await order())).toMatchObject({ status: 'CANCELLED', cancelReason: 'No delivery address received' });
  });
});

describe('admin actions notify the customer', () => {
  it('admin cancellation tells the customer no payment was taken', async () => {
    await post(cartWebhook(id('CART'), [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]));
    const o = await order();
    await runAction(o.id, 'cancel', { ...admin(o.version), reason: 'Damaged in storage' });

    expect(content(last()).body).toMatch(/had to cancel your order .* No payment was taken/);
    expect(content(last()).body).not.toContain('Damaged'); // internal reason stays internal
  });

  it('resend repeats the current request', async () => {
    const o = await revisedOrderSent();
    const before = wa.sent.length;
    const res = await runAction(o.id, 'resend', admin(o.version));
    expect(res.warning).toBeUndefined();
    expect(wa.sent.length).toBe(before + 1);
    expect(content(last()).buttons[0].id).toBe(`qz:accept:${o.id}:1`); // same round
  });

  it('reports a warning (but keeps the approval) when WhatsApp sending fails', async () => {
    await post(cartWebhook(id('CART'), [{ retailerId: 'QZ-NCK-001', quantity: 1, price: 348 }]));
    const o = await order();
    wa.sendAddressRequest = async () => {
      throw new Error('WhatsApp is down');
    };
    const res = await runAction(o.id, 'approve', admin(o.version));
    expect(res.order.status).toBe('AWAITING_ADDRESS');
    expect(res.warning).toMatch(/WhatsApp is down/);
  });
});
