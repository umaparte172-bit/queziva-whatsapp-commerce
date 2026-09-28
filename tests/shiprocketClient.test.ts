import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { ShiprocketLiveClient } from '../src/integrations/shiprocket/live.js';
import type { CreateShipmentRequest } from '../src/integrations/shiprocket/types.js';

const liveEnv = {
  ...env,
  SHIPROCKET_EMAIL: 'api@queziva.test',
  SHIPROCKET_PASSWORD: 'test-password',
  SHIPROCKET_WEBHOOK_TOKEN: 'hook-token',
  SHIPROCKET_FALLBACK_EMAIL: 'orders@queziva.test',
  SHIPROCKET_API_BASE: 'https://sr.test/v1/external',
};

interface Call {
  method: string;
  url: string;
  auth?: string;
  body: any;
}

type Reply = { status: number; body: object };

/** Fake fetch: routes by "METHOD path" prefix to queued replies; logins always succeed with a numbered token. */
function fakeShiprocket(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  let logins = 0;
  const impl = (async (url: string, init: RequestInit) => {
    const path = url.replace(liveEnv.SHIPROCKET_API_BASE, '');
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url: path,
      auth: (init.headers as Record<string, string>).Authorization,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path === '/auth/login') {
      logins++;
      return new Response(JSON.stringify({ token: `token-${logins}` }), { status: 200 });
    }
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    const reply = key ? routes[key]!.shift() : undefined;
    if (!reply) throw new Error(`Unexpected call ${method} ${path}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { calls, impl, logins: () => logins };
}

const rateRequest = {
  pickupPincode: '110001',
  deliveryPincode: '411001',
  weightKg: 0.23,
  lengthCm: 15,
  breadthCm: 12,
  heightCm: 9,
  declaredValuePaise: 64700,
  cod: false,
};

const serviceability = {
  status: 200,
  data: {
    recommended_courier_company_id: 24,
    available_courier_companies: [
      { courier_company_id: 10, courier_name: 'Delhivery Surface', rate: 58.4, estimated_delivery_days: '5', rating: 4.2 },
      { courier_company_id: 24, courier_name: 'Xpressbees', rate: '61', estimated_delivery_days: '3', rating: 4.5 },
      { courier_company_id: 33, courier_name: 'Blocked Co', rate: 40, blocked: 1 },
    ],
  },
};

function client(routes: Record<string, Reply[]>, now = () => Date.now()) {
  const f = fakeShiprocket(routes);
  return { f, sr: new ShiprocketLiveClient(liveEnv, { fetchImpl: f.impl, retryDelayMs: 1, now }) };
}

describe('ShiprocketLiveClient', () => {
  it('logs in once and reuses the token across calls', async () => {
    const { f, sr } = client({ 'GET /courier/serviceability': [{ status: 200, body: serviceability }, { status: 200, body: serviceability }] });
    await sr.getRates(rateRequest);
    await sr.getRates(rateRequest);
    expect(f.logins()).toBe(1);
    expect(f.calls[0]!.body).toEqual({ email: 'api@queziva.test', password: 'test-password' });
    expect(f.calls.filter((c) => c.url.startsWith('/courier')).every((c) => c.auth === 'Bearer token-1')).toBe(true);
  });

  it('shares one login between simultaneous requests', async () => {
    const { f, sr } = client({ 'GET /courier/serviceability': [{ status: 200, body: serviceability }, { status: 200, body: serviceability }] });
    await Promise.all([sr.getRates(rateRequest), sr.getRates(rateRequest)]);
    expect(f.logins()).toBe(1);
  });

  it('refreshes the token after 9 days and when Shiprocket rejects it', async () => {
    let clock = Date.now();
    const { f, sr } = client(
      {
        'GET /courier/serviceability': [
          { status: 200, body: serviceability },
          { status: 200, body: serviceability },
          { status: 401, body: { message: 'Token has expired' } },
          { status: 200, body: serviceability },
        ],
      },
      () => clock,
    );
    await sr.getRates(rateRequest);
    clock += 9 * 24 * 3600 * 1000 + 1;
    await sr.getRates(rateRequest);
    expect(f.logins()).toBe(2);
    await sr.getRates(rateRequest); // 401 → log in again → retry
    expect(f.logins()).toBe(3);
  });

  it('maps serviceability to courier options in paise', async () => {
    const { f, sr } = client({ 'GET /courier/serviceability': [{ status: 200, body: serviceability }] });
    const options = await sr.getRates(rateRequest);

    expect(f.calls[1]!.url).toBe(
      '/courier/serviceability/?pickup_postcode=110001&delivery_postcode=411001&weight=0.230&cod=0&declared_value=647&length=15&breadth=12&height=9',
    );
    expect(options).toEqual([
      { courierId: 10, courierName: 'Delhivery Surface', ratePaise: 5840, etdDays: 5, rating: 4.2, recommended: false },
      { courierId: 24, courierName: 'Xpressbees', ratePaise: 6100, etdDays: 3, rating: 4.5, recommended: true },
    ]);
  });

  it('treats 404 as "no courier delivers here"', async () => {
    const { sr } = client({ 'GET /courier/serviceability': [{ status: 404, body: { message: 'Delivery postcode not serviceable' } }] });
    expect(await sr.getRates(rateRequest)).toEqual([]);
  });

  it('retries server errors, and surfaces validation errors', async () => {
    const { f, sr } = client({
      'GET /courier/serviceability': [
        { status: 502, body: { message: 'Bad gateway' } },
        { status: 200, body: serviceability },
        { status: 422, body: { message: 'The weight field is required.' } },
      ],
    });
    expect(await sr.getRates(rateRequest)).toHaveLength(2);
    expect(f.calls.filter((c) => c.url.startsWith('/courier')).length).toBe(2);
    await expect(sr.getRates(rateRequest)).rejects.toThrow(/weight field is required/);
  });

  it('creates an order with the Shiprocket field names', async () => {
    const { f, sr } = client({ 'POST /orders/create/adhoc': [{ status: 200, body: { order_id: 55501, shipment_id: 88802, status: 'NEW' } }] });
    const request: CreateShipmentRequest = {
      orderNumber: 'QZ260928001',
      orderDate: new Date('2026-09-28T12:15:00Z'),
      pickupLocation: 'Primary',
      customer: { name: 'Priya Anand Sharma', phone: '9876543210', address: 'Flat 12B, Lotus Heights', address2: 'MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      items: [{ name: 'Pearl Drop Earrings', sku: 'QZ-EAR-001', units: 1, sellingPricePaise: 29900, hsn: '7117', taxRateBps: 300 }],
      paymentMethod: 'Prepaid',
      subTotalPaise: 29900,
      shippingPaise: 5900,
      discountPaise: 0,
      weightKg: 0.11,
      lengthCm: 8,
      breadthCm: 8,
      heightCm: 4,
    };
    expect(await sr.createOrder(request)).toEqual({ shiprocketOrderId: '55501', shipmentId: '88802' });

    const body = f.calls.at(-1)!.body;
    expect(body).toMatchObject({
      order_id: 'QZ260928001',
      order_date: '2026-09-28 17:45', // IST
      billing_customer_name: 'Priya',
      billing_last_name: 'Anand Sharma',
      billing_address: 'Flat 12B, Lotus Heights',
      billing_address_2: 'MG Road',
      billing_pincode: '411001',
      billing_country: 'India',
      billing_email: 'orders@queziva.test',
      billing_phone: '9876543210',
      shipping_is_billing: true,
      payment_method: 'Prepaid',
      shipping_charges: 59,
      sub_total: 299,
      weight: 0.11,
    });
    expect(body.order_items).toEqual([{ name: 'Pearl Drop Earrings', sku: 'QZ-EAR-001', units: 1, selling_price: 299, discount: 0, tax: 3, hsn: '7117' }]);
  });

  it('assigns an AWB, requests pickup and tracks the shipment', async () => {
    const { f, sr } = client({
      'POST /courier/assign/awb': [
        { status: 200, body: { awb_assign_status: 1, response: { data: { awb_code: '1409118223', courier_company_id: 24, courier_name: 'Xpressbees' } } } },
      ],
      'POST /courier/generate/pickup': [{ status: 400, body: { message: 'Already in Pickup Queue.' } }],
      'GET /courier/track/awb': [
        {
          status: 200,
          body: {
            tracking_data: {
              track_status: 1,
              shipment_track: [{ current_status: 'IN TRANSIT' }],
              track_url: 'https://shiprocket.co/tracking/1409118223',
              shipment_track_activities: [{ date: '2026-09-29 10:15:00', 'sr-status-label': 'IN TRANSIT', location: 'Mumbai Hub' }],
            },
          },
        },
      ],
    });
    expect(await sr.assignAwb('88802', 24)).toEqual({ awb: '1409118223', courierId: 24, courierName: 'Xpressbees' });
    expect(f.calls.at(-1)!.body).toEqual({ shipment_id: 88802, courier_id: 24 });

    await expect(sr.requestPickup('88802')).resolves.toBeUndefined(); // "already queued" is fine

    const tracking = await sr.track('1409118223');
    expect(tracking).toMatchObject({ currentStatus: 'IN TRANSIT', trackingUrl: 'https://shiprocket.co/tracking/1409118223' });
    expect(tracking.events[0]).toEqual({ status: 'IN TRANSIT', location: 'Mumbai Hub', at: new Date('2026-09-29T04:45:00Z') });
  });

  it('reports an AWB assignment failure clearly', async () => {
    const { sr } = client({
      'POST /courier/assign/awb': [{ status: 200, body: { awb_assign_status: 0, response: { data: { awb_assign_error: 'Insufficient wallet balance' } } } }],
    });
    await expect(sr.assignAwb('88802')).rejects.toThrow(/Insufficient wallet balance/);
  });

  it('checks the webhook token', () => {
    const { sr } = client({});
    expect(sr.verifyWebhookToken('hook-token')).toBe(true);
    expect(sr.verifyWebhookToken('nope')).toBe(false);
  });
});
