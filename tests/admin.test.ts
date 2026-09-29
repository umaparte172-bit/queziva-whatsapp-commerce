import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword, signSession, verifyPassword, verifySession } from '../src/lib/auth.js';
import { prisma } from '../src/lib/prisma.js';
import { resetLoginThrottle } from '../src/routes/admin/auth.js';
import { createOrderRequest } from '../src/services/orders.js';
import { resetDb, seedProduct } from './helpers.js';

const PASSWORD = 'test-password-123';
let server: Server;
let baseUrl: string;
let cookie: string;
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

let earrings: { id: string };
let necklace: { id: string };
let ring: { id: string };

beforeEach(async () => {
  await resetDb();
  resetLoginThrottle();
  await prisma.adminUser.create({ data: { email: 'admin@test.local', name: 'Asha', passwordHash } });
  earrings = await seedProduct(); // stock 1
  necklace = await seedProduct({ sku: 'QZ-NCK-001', retailerId: 'QZ-NCK-001', name: 'Kundan Choker', pricePaise: 34800, stock: 5 });
  ring = await seedProduct({ sku: 'QZ-RNG-001', retailerId: 'QZ-RNG-001', name: 'Solitaire Ring', pricePaise: 19900, stock: 12 });
  cookie = await login();
});

async function login(email = 'admin@test.local', password = PASSWORD) {
  const res = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw Object.assign(new Error(`login ${res.status}`), { status: res.status });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function api(method: string, path: string, body?: object, withCookie = true) {
  const res = await fetch(`${baseUrl}/api/admin${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(withCookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

function placeOrder(items: { retailerId: string; quantity: number }[], waId = '919876543210') {
  return createOrderRequest({ waId, customerName: 'Priya', items });
}

describe('password hashing and sessions', () => {
  it('verifies the right password only', async () => {
    expect(await verifyPassword(PASSWORD, passwordHash)).toBe(true);
    expect(await verifyPassword('wrong-password', passwordHash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
  });

  it('rejects tampered or expired session tokens', () => {
    const token = signSession({ sub: 'a1', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');
    expect(verifySession(token, 'secret')?.sub).toBe('a1');
    expect(verifySession(token, 'other-secret')).toBeNull();
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: 9999999999 })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`, 'secret')).toBeNull();
    expect(verifySession(`${body}.${sig}`, 'secret', Date.now() + 120_000)).toBeNull();
  });
});

describe('admin authentication', () => {
  it('requires a session for admin endpoints', async () => {
    expect((await api('GET', '/orders', undefined, false)).status).toBe(401);
    expect((await api('GET', '/auth/me')).body.admin).toMatchObject({ email: 'admin@test.local', name: 'Asha' });
  });

  it('sets an HttpOnly, SameSite=Strict cookie', async () => {
    const res = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ADMIN@test.local', password: PASSWORD }),
    });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
  });

  it('rejects wrong passwords and deactivated admins', async () => {
    await expect(login('admin@test.local', 'nope')).rejects.toMatchObject({ status: 401 });
    await prisma.adminUser.updateMany({ data: { active: false } });
    await expect(login()).rejects.toMatchObject({ status: 401 });
    expect((await api('GET', '/orders')).status).toBe(401); // existing session stops working too
  });

  it('throttles repeated failed sign-ins', async () => {
    for (let i = 0; i < 10; i++) await login('admin@test.local', 'nope').catch(() => {});
    await expect(login()).rejects.toMatchObject({ status: 429 });
  });

  it('only accepts JSON for changes', async () => {
    const res = await fetch(`${baseUrl}/api/admin/orders/x/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: 'note=hi',
    });
    expect(res.status).toBe(415);
  });
});

describe('product image upload', () => {
  it('stores a valid image and rejects invalid image bytes', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const uploaded = await fetch(`${baseUrl}/api/admin/product-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Cookie: cookie },
      body: png,
    });
    expect(uploaded.status).toBe(201);
    const result = (await uploaded.json()) as { imageUrl: string };
    expect(result.imageUrl).toMatch(/\/catalogue\/uploads\/[0-9a-f-]+\.png$/);

    const filename = path.basename(new URL(result.imageUrl).pathname);
    try {
      const invalid = await fetch(`${baseUrl}/api/admin/product-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Cookie: cookie },
        body: Buffer.from('not an image'),
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.code).toBe('INVALID_IMAGE');
    } finally {
      await unlink(path.resolve(process.cwd(), 'public', 'catalogue', 'uploads', filename));
    }
  });

  it('requires an admin session', async () => {
    const res = await fetch(`${baseUrl}/api/admin/product-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    expect(res.status).toBe(401);
  });
});

describe('order review', () => {
  it('handles the key scenario: 2 requested, 1 in stock → reduce → send to customer', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-EAR-001', quantity: 2 }]);
    let detail = (await api('GET', `/orders/${order.id}`)).body;

    expect(detail.status).toBe('NEW');
    expect(detail.stockProblems[0].message).toBe('Pearl Drop Earrings: 2 requested, only 1 in stock');
    expect(detail.items[0]).toMatchObject({ requestedQuantity: 2, quantity: 2, availableStock: 1, stockIssue: true });

    // Approving with a stock problem is refused
    const blocked = await api('POST', `/orders/${order.id}/actions/approve`, { expectedVersion: detail.version });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Fix stock before approving/);

    detail = (await api('POST', `/orders/${order.id}/actions/start_review`, { expectedVersion: detail.version })).body;
    expect(detail.status).toBe('PENDING_REVIEW');

    const edited = await api('PATCH', `/orders/${order.id}/items/${detail.items[0].id}`, {
      expectedVersion: detail.version,
      quantity: 1,
    });
    expect(edited.status).toBe(200);
    detail = edited.body;
    expect(detail.status).toBe('MODIFIED');
    expect(detail.subtotalPaise).toBe(29900);
    expect(detail.items[0]).toMatchObject({ requestedQuantity: 2, quantity: 1, stockIssue: false });
    expect(detail.actions.map((a: any) => a.label)).toContain('Send revised order to customer');

    detail = (await api('POST', `/orders/${order.id}/actions/approve`, { expectedVersion: detail.version })).body;
    expect(detail.status).toBe('AWAITING_CUSTOMER_APPROVAL');

    const history = detail.events.map((e: any) => e.type);
    expect(history).toEqual(expect.arrayContaining(['CREATED', 'ITEM_UPDATED', 'TOTALS_RECALCULATED', 'STATUS_CHANGED']));
    const edit = detail.events.find((e: any) => e.type === 'ITEM_UPDATED');
    expect(edit).toMatchObject({ actor: 'ADMIN', actorName: 'Asha', message: 'Pearl Drop Earrings: quantity 2 → 1' });
    expect(detail.events.find((e: any) => e.type === 'TOTALS_RECALCULATED').message).toBe('Total ₹598 → ₹299');
  });

  it('approves an unchanged order straight to address collection', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-NCK-001', quantity: 2 }]);
    const res = await api('POST', `/orders/${order.id}/actions/approve`, { expectedVersion: order.version });
    expect(res.body.status).toBe('AWAITING_ADDRESS');
  });

  it('returns to Pending Review when edits are undone', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-NCK-001', quantity: 2 }]);
    const itemId = order.items[0]!.id;
    let d = (await api('PATCH', `/orders/${order.id}/items/${itemId}`, { expectedVersion: order.version, quantity: 1 })).body;
    expect(d.status).toBe('MODIFIED');
    d = (await api('PATCH', `/orders/${order.id}/items/${itemId}`, { expectedVersion: d.version, quantity: 2 })).body;
    expect(d.status).toBe('PENDING_REVIEW');
    expect(d.modified).toBe(false);
  });

  it('re-opens a revised order sent to the customer when the admin edits it again', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-NCK-001', quantity: 3 }]);
    const itemId = order.items[0]!.id;
    let d = (await api('PATCH', `/orders/${order.id}/items/${itemId}`, { expectedVersion: order.version, quantity: 2 })).body;
    d = (await api('POST', `/orders/${order.id}/actions/approve`, { expectedVersion: d.version })).body;
    expect(d.status).toBe('AWAITING_CUSTOMER_APPROVAL');
    d = (await api('PATCH', `/orders/${order.id}/items/${itemId}`, { expectedVersion: d.version, quantity: 1 })).body;
    expect(d.status).toBe('MODIFIED');
  });

  it('adds, replaces and removes items with totals kept in sync', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-EAR-001', quantity: 1 }]);
    let d = (await api('POST', `/orders/${order.id}/items`, { expectedVersion: order.version, productId: ring.id, quantity: 2 })).body;
    expect(d.items).toHaveLength(2);
    expect(d.items[1]).toMatchObject({ sku: 'QZ-RNG-001', requestedQuantity: 0, quantity: 2, addedByAdmin: true });
    expect(d.subtotalPaise).toBe(29900 + 2 * 19900);

    const earringLine = d.items.find((i: any) => i.sku === 'QZ-EAR-001');
    d = (await api('POST', `/orders/${order.id}/items/${earringLine.id}/replace`, { expectedVersion: d.version, productId: necklace.id })).body;
    const replacement = d.items.find((i: any) => i.sku === 'QZ-NCK-001');
    expect(replacement).toMatchObject({ quantity: 1, replacesItemId: earringLine.id });
    expect(d.items.find((i: any) => i.id === earringLine.id)).toMatchObject({ removed: true, quantity: 0, requestedQuantity: 1 });
    expect(d.subtotalPaise).toBe(34800 + 2 * 19900);

    d = (await api('POST', `/orders/${order.id}/items/${replacement.id}/remove`, { expectedVersion: d.version })).body;
    expect(d.subtotalPaise).toBe(2 * 19900);

    const ringLine = d.items.find((i: any) => i.sku === 'QZ-RNG-001');
    const last = await api('POST', `/orders/${order.id}/items/${ringLine.id}/remove`, { expectedVersion: d.version });
    expect(last.status).toBe(400);
    expect(last.body.error.message).toMatch(/cancel the order instead/);
  });

  it('refuses to add a product that is already in the order', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-RNG-001', quantity: 1 }]);
    const res = await api('POST', `/orders/${order.id}/items`, { expectedVersion: order.version, productId: ring.id, quantity: 1 });
    expect(res.status).toBe(400);
  });

  it('applies a discount within the subtotal', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-RNG-001', quantity: 2 }]);
    const tooBig = await api('PUT', `/orders/${order.id}/discount`, { expectedVersion: order.version, discountPaise: 50000 });
    expect(tooBig.status).toBe(400);

    const d = (await api('PUT', `/orders/${order.id}/discount`, { expectedVersion: order.version, discountPaise: 5000, reason: 'Loyal customer' })).body;
    expect(d).toMatchObject({ discountPaise: 5000, discountReason: 'Loyal customer', totalPaise: 2 * 19900 - 5000 });
    expect(d.status).toBe('NEW'); // a discount alone does not need customer approval
  });

  it('rejects edits based on an out-of-date version', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-RNG-001', quantity: 2 }]);
    const itemId = order.items[0]!.id;
    await api('PATCH', `/orders/${order.id}/items/${itemId}`, { expectedVersion: order.version, quantity: 1 });
    const stale = await api('PATCH', `/orders/${order.id}/items/${itemId}`, { expectedVersion: order.version, quantity: 3 });
    expect(stale.status).toBe(409);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).quantity).toBe(1);
  });

  it('locks items once the order is approved', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-RNG-001', quantity: 1 }]);
    const d = (await api('POST', `/orders/${order.id}/actions/approve`, { expectedVersion: order.version })).body;
    expect(d.permissions).toEqual({ editItems: false, editDiscount: true, editAddress: true, editShipping: false });
    const res = await api('PATCH', `/orders/${order.id}/items/${order.items[0]!.id}`, { expectedVersion: d.version, quantity: 2 });
    expect(res.status).toBe(409);
  });

  it('requires a reason to cancel and keeps notes in the history', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-RNG-001', quantity: 1 }]);
    expect((await api('POST', `/orders/${order.id}/actions/cancel`, { expectedVersion: order.version })).status).toBe(400);

    await api('POST', `/orders/${order.id}/notes`, { note: 'Customer called, wants to cancel' });
    const d = (await api('POST', `/orders/${order.id}/actions/cancel`, { expectedVersion: order.version, reason: 'Customer request' })).body;
    expect(d).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer request' });
    expect(d.actions).toEqual([]);
    expect(d.events.find((e: any) => e.type === 'NOTE').message).toBe('Customer called, wants to cancel');
  });
});

describe('order lists', () => {
  it('filters by status, search and stock issues, and counts per status', async () => {
    const short = await placeOrder([{ retailerId: 'QZ-EAR-001', quantity: 2 }], '919000000001');
    const fine = await placeOrder([{ retailerId: 'QZ-RNG-001', quantity: 1 }], '919000000002');
    await api('POST', `/orders/${fine.id}/actions/approve`, { expectedVersion: fine.version });

    const all = (await api('GET', '/orders')).body;
    expect(all.total).toBe(2);
    expect(all.orders.find((o: any) => o.id === short.id)).toMatchObject({ stockIssue: true, itemsSummary: 'Pearl Drop Earrings × 2' });

    expect((await api('GET', '/orders?status=NEW,PENDING_REVIEW')).body.orders.map((o: any) => o.id)).toEqual([short.id]);
    expect((await api('GET', '/orders?stockIssues=1')).body.orders.map((o: any) => o.id)).toEqual([short.id]);
    expect((await api('GET', '/orders?q=9000000002')).body.orders.map((o: any) => o.id)).toEqual([fine.id]);
    expect((await api('GET', `/orders?q=${short.requestNumber.toLowerCase()}`)).body.orders.map((o: any) => o.id)).toEqual([short.id]);
    expect((await api('GET', '/orders?status=BOGUS')).status).toBe(400);
    expect((await api('GET', '/orders?q=priya')).body.total).toBe(2); // names match regardless of case

    const summary = (await api('GET', '/orders/summary')).body;
    expect(summary).toEqual({ counts: { NEW: 1, AWAITING_ADDRESS: 1 }, stockIssues: 1 });
  });
});

describe('products', () => {
  it('creates, lists, updates stock and hides inactive products', async () => {
    const created = await api('POST', '/products', { sku: 'qz-anklet-01', name: 'Silver Anklet', pricePaise: 39900, stock: 4 });
    expect(created.status).toBe(201);
    // SKU is normalised to upper case; the catalogue ID keeps the case typed (Meta Content IDs are exact).
    expect(created.body.product).toMatchObject({ sku: 'QZ-ANKLET-01', retailerId: 'qz-anklet-01', gstRateBps: 300 });

    const dup = await api('POST', '/products', { sku: 'QZ-ANKLET-01', name: 'Dup', pricePaise: 1, stock: 1 });
    expect(dup.status).toBe(409);

    const updated = await api('PATCH', `/products/${created.body.product.id}`, { stock: 9, active: false });
    expect(updated.body.product).toMatchObject({ stock: 9, active: false });

    expect((await api('GET', '/products')).body.products.map((p: any) => p.sku)).not.toContain('QZ-ANKLET-01');
    expect((await api('GET', '/products?includeInactive=1')).body.products.map((p: any) => p.sku)).toContain('QZ-ANKLET-01');
    expect((await api('POST', '/products', { sku: 'X', name: 'Bad', pricePaise: -5, stock: 1 })).status).toBe(400);
  });

  it('lets stock changes clear an order stock issue', async () => {
    const order = await placeOrder([{ retailerId: 'QZ-EAR-001', quantity: 2 }]);
    await api('PATCH', `/products/${earrings.id}`, { stock: 5 });
    const d = (await api('GET', `/orders/${order.id}`)).body;
    expect(d.stockProblems).toEqual([]);
  });
});
