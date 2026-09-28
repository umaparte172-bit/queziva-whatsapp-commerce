import { describe, expect, it } from 'vitest';
import { integrationModes, integrations } from '../src/integrations/index.js';
import { MOCK_RAZORPAY_WEBHOOK_SECRET, MockRazorpayClient } from '../src/integrations/razorpay/mock.js';
import { MOCK_SHIPROCKET_WEBHOOK_TOKEN, MockShiprocketClient } from '../src/integrations/shiprocket/mock.js';
import { MockWhatsAppClient } from '../src/integrations/whatsapp/mock.js';
import { hmacSha256Hex, verifyHmacSha256 } from '../src/lib/signature.js';

const rateRequest = {
  pickupPincode: '110001',
  weightKg: 0.1,
  lengthCm: 10,
  breadthCm: 10,
  heightCm: 5,
  declaredValuePaise: 50000,
  cod: false,
};

describe('integration registry', () => {
  it('uses mocks when configured', () => {
    expect(integrationModes()).toEqual({ whatsapp: 'mock', razorpay: 'mock', shiprocket: 'mock' });
    expect(integrations().whatsapp).toBeInstanceOf(MockWhatsAppClient);
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ event: 'payment.captured' });

  it('accepts a correct HMAC and rejects tampered bodies or bad signatures', () => {
    const sig = hmacSha256Hex('secret', body);
    expect(verifyHmacSha256('secret', body, sig)).toBe(true);
    expect(verifyHmacSha256('secret', body + ' ', sig)).toBe(false);
    expect(verifyHmacSha256('secret', body, 'zz')).toBe(false);
    expect(verifyHmacSha256('secret', body, '')).toBe(false);
  });

  it('mock Razorpay verifies with its fixed test secret', () => {
    const client = new MockRazorpayClient();
    expect(client.verifyWebhookSignature(body, hmacSha256Hex(MOCK_RAZORPAY_WEBHOOK_SECRET, body))).toBe(true);
    expect(client.verifyWebhookSignature(body, hmacSha256Hex('wrong', body))).toBe(false);
  });

  it('mock Shiprocket checks the webhook token', () => {
    const client = new MockShiprocketClient();
    expect(client.verifyWebhookToken(MOCK_SHIPROCKET_WEBHOOK_TOKEN)).toBe(true);
    expect(client.verifyWebhookToken('nope')).toBe(false);
    expect(client.verifyWebhookToken(undefined)).toBe(false);
  });
});

describe('MockShiprocketClient', () => {
  const client = new MockShiprocketClient();

  it('prices by zone, cheapest first', async () => {
    const local = await client.getRates({ ...rateRequest, deliveryPincode: '110005' });
    const national = await client.getRates({ ...rateRequest, deliveryPincode: '560001' });
    expect(local[0]!.ratePaise).toBe(4000);
    expect(national[0]!.ratePaise).toBe(7000);
    expect(local[0]!.ratePaise).toBeLessThanOrEqual(local[1]!.ratePaise);
  });

  it('charges extra 500 g slabs using volumetric weight', async () => {
    // 30×20×10 / 5000 = 1.2 kg → 3 slabs
    const [rate] = await client.getRates({ ...rateRequest, deliveryPincode: '110005', lengthCm: 30, breadthCm: 20, heightCm: 10 });
    expect(rate!.ratePaise).toBe(4000 + 2 * 2000);
  });

  it('returns no couriers for unserviceable pincodes', async () => {
    expect(await client.getRates({ ...rateRequest, deliveryPincode: '012345' })).toEqual([]);
  });

  it('creates a shipment and assigns an AWB', async () => {
    const created = await client.createOrder({
      orderNumber: 'QZ260928001',
      orderDate: new Date(),
      pickupLocation: 'Primary',
      customer: { name: 'Priya', phone: '9876543210', address: 'Flat 12B', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      items: [{ name: 'Earrings', sku: 'QZ-EAR-001', units: 1, sellingPricePaise: 29900 }],
      paymentMethod: 'Prepaid',
      subTotalPaise: 29900,
      shippingPaise: 7000,
      discountPaise: 0,
      weightKg: 0.06,
      lengthCm: 8,
      breadthCm: 8,
      heightCm: 4,
    });
    const awb = await client.assignAwb(created.shipmentId);
    expect(awb.awb).toMatch(/^MOCK\d{8}$/);
  });
});

describe('MockRazorpayClient', () => {
  it('simulates a payment and a full refund', async () => {
    const client = new MockRazorpayClient();
    const payment = client.simulatePayment({ amountPaise: 36900, referenceId: 'RQ260928001' });
    expect((await client.fetchPayment(payment.id)).status).toBe('captured');
    await client.refundPayment(payment.id);
    expect((await client.fetchPayment(payment.id)).status).toBe('refunded');
  });
});

describe('MockWhatsAppClient', () => {
  it('enforces WhatsApp button limits', async () => {
    const client = new MockWhatsAppClient();
    await expect(
      client.sendButtons(WA(), { body: 'x', buttons: [{ id: 'a', title: 'This title is far too long' }] }),
    ).rejects.toThrow(/20 characters/);
    await client.sendButtons(WA(), { body: 'Order update', buttons: [{ id: 'accept', title: 'Accept Updated Order' }] });
    expect(client.lastTo(WA())?.kind).toBe('buttons');
  });
});

function WA() {
  return '919876543210';
}
