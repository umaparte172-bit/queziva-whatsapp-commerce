import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { WhatsAppCloudClient, WhatsAppApiError } from '../src/integrations/whatsapp/live.js';
import type { OrderDetailsMessage } from '../src/integrations/whatsapp/types.js';
import { validateOrderDetails } from '../src/integrations/whatsapp/validate.js';
import { parseWebhook } from '../src/integrations/whatsapp/webhook.js';
import { hmacSha256Hex } from '../src/lib/signature.js';
import { addressReplyWebhook, cartWebhook, paymentWebhook, statusWebhook } from './fixtures/whatsapp.js';

const liveEnv = {
  ...env,
  WHATSAPP_ACCESS_TOKEN: 'test-token',
  WHATSAPP_PHONE_NUMBER_ID: 'PNID',
  WHATSAPP_CATALOG_ID: 'CATALOG_1',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
  WHATSAPP_PAYMENT_CONFIGURATION: 'queziva-razorpay',
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Fake fetch that records requests and replays the given responses in order. */
function fakeFetch(responses: { status: number; body: object }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = responses.shift() ?? { status: 200, body: { messages: [{ id: 'wamid.DEFAULT' }] } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, impl };
}

const ok = (id = 'wamid.OK') => ({ status: 200, body: { messaging_product: 'whatsapp', messages: [{ id }] } });

function client(responses: { status: number; body: object }[] = [ok()]) {
  const f = fakeFetch(responses);
  return { f, wa: new WhatsAppCloudClient(liveEnv, { fetchImpl: f.impl, retryDelayMs: 1 }) };
}

const orderDetails: OrderDetailsMessage = {
  referenceId: 'QZPAY-RQ260928001-1',
  body: 'Your Queziva order is ready for payment',
  items: [{ retailerId: 'QZ-EAR-001', name: 'Pearl Drop Earrings', amountPaise: 29900, quantity: 1 }],
  subtotalPaise: 29900,
  discountPaise: 0,
  shippingPaise: 7000,
  shippingDescription: 'Delhivery Surface',
  taxPaise: 0,
  taxDescription: 'Inclusive of GST',
  totalPaise: 36900,
};

describe('WhatsAppCloudClient', () => {
  it('posts text messages to the phone number endpoint with the bearer token', async () => {
    const { f, wa } = client([ok('wamid.T1')]);
    const result = await wa.sendText('919876543210', 'Hello');

    expect(result.messageId).toBe('wamid.T1');
    expect(f.calls[0]!.url).toBe(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/PNID/messages`);
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer test-token');
    expect(f.calls[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'text',
      text: { body: 'Hello', preview_url: false },
    });
  });

  it('builds reply-button messages', async () => {
    const { f, wa } = client();
    await wa.sendButtons('919876543210', {
      header: 'Order Update – Queziva',
      body: 'Only 1 piece is available.',
      buttons: [
        { id: 'accept:o1', title: 'Accept Updated Order' },
        { id: 'cancel:o1', title: 'Cancel Order' },
      ],
    });
    expect(f.calls[0]!.body.interactive).toEqual({
      type: 'button',
      header: { type: 'text', text: 'Order Update – Queziva' },
      body: { text: 'Only 1 piece is available.' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'accept:o1', title: 'Accept Updated Order' } },
          { type: 'reply', reply: { id: 'cancel:o1', title: 'Cancel Order' } },
        ],
      },
    });
  });

  it('builds a native order_details (Review and Pay) message with the Razorpay configuration', async () => {
    const { f, wa } = client();
    await wa.sendOrderDetails('919876543210', orderDetails);
    const interactive = f.calls[0]!.body.interactive;

    expect(interactive.type).toBe('order_details');
    expect(interactive.action.name).toBe('review_and_pay');
    const p = interactive.action.parameters;
    expect(p.reference_id).toBe('QZPAY-RQ260928001-1');
    expect(p.type).toBe('physical-goods');
    expect(p.payment_settings).toEqual([
      {
        type: 'payment_gateway',
        payment_gateway: {
          type: 'razorpay',
          configuration_name: 'queziva-razorpay',
          razorpay: { receipt: 'QZPAY-RQ260928001-1', notes: { reference_id: 'QZPAY-RQ260928001-1' } },
        },
      },
    ]);
    expect(p.total_amount).toEqual({ value: 36900, offset: 100 });
    expect(p.order).toEqual({
      status: 'pending',
      catalog_id: 'CATALOG_1',
      items: [{ retailer_id: 'QZ-EAR-001', name: 'Pearl Drop Earrings', amount: { value: 29900, offset: 100 }, quantity: 1 }],
      subtotal: { value: 29900, offset: 100 },
      tax: { value: 0, offset: 100, description: 'Inclusive of GST' },
      shipping: { value: 7000, offset: 100, description: 'Delhivery Surface' },
    });
  });

  it('builds the India address_message with prefilled values', async () => {
    const { f, wa } = client();
    await wa.sendAddressRequest('919876543210', 'Please share your delivery address', {
      name: 'Priya',
      phoneNumber: '919876543210',
      inPinCode: '411001',
    });
    expect(f.calls[0]!.body.interactive).toEqual({
      type: 'address_message',
      body: { text: 'Please share your delivery address' },
      action: {
        name: 'address_message',
        parameters: { country: 'IN', values: { name: 'Priya', phone_number: '919876543210', in_pin_code: '411001' } },
      },
    });
  });

  it('builds order_status and template messages and marks messages read', async () => {
    const { f, wa } = client([ok(), ok(), { status: 200, body: { success: true } }]);
    await wa.sendOrderStatus('919876543210', {
      referenceId: 'QZPAY-1',
      status: 'shipped',
      body: 'Your order has shipped',
      description: 'AWB 123',
    });
    await wa.sendTemplate('919876543210', { name: 'order_dispatched', language: 'en', components: [] });
    await wa.markRead('wamid.IN1');

    expect(f.calls[0]!.body.interactive.action).toEqual({
      name: 'review_order',
      parameters: { reference_id: 'QZPAY-1', order: { status: 'shipped', description: 'AWB 123' } },
    });
    expect(f.calls[1]!.body.template).toEqual({ name: 'order_dispatched', language: { code: 'en' }, components: [] });
    expect(f.calls[2]!.body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1' });
  });

  it('builds a link-button (cta_url) message and validates the link', async () => {
    const { f, wa } = client();
    await wa.sendCtaUrl('919876543210', { body: 'Your order has shipped', buttonText: 'Track Shipment', url: 'https://shiprocket.co/tracking/123' });
    expect(f.calls[0]!.body.interactive).toEqual({
      type: 'cta_url',
      body: { text: 'Your order has shipped' },
      action: { name: 'cta_url', parameters: { display_text: 'Track Shipment', url: 'https://shiprocket.co/tracking/123' } },
    });
    await expect(wa.sendCtaUrl('919876543210', { body: 'x', buttonText: 'Track', url: 'http://insecure.test' })).rejects.toThrow(/https/);
  });

  it('explains the 24-hour window error and does not retry it', async () => {
    const { f, wa } = client([
      { status: 400, body: { error: { code: 131047, message: 'Re-engagement message', fbtrace_id: 'TRACE' } } },
    ]);
    const error = await wa.sendText('919876543210', 'Hi').catch((e) => e);
    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect(error.message).toMatch(/24 hours/);
    expect(error.graphCode).toBe(131047);
    expect(f.calls).toHaveLength(1);
  });

  it('retries on server errors and rate limits', async () => {
    const { f, wa } = client([
      { status: 500, body: { error: { code: 1, message: 'Unknown' } } },
      { status: 429, body: { error: { code: 130429, message: 'Rate limit' } } },
      ok('wamid.AFTER_RETRY'),
    ]);
    expect((await wa.sendText('919876543210', 'Hi')).messageId).toBe('wamid.AFTER_RETRY');
    expect(f.calls).toHaveLength(3);
  });

  it('validates before calling the API', async () => {
    const { f, wa } = client();
    await expect(
      wa.sendButtons('919876543210', { body: 'x', buttons: [{ id: 'a', title: 'A title that is too long' }] }),
    ).rejects.toThrow(/20 characters/);
    await expect(wa.sendOrderDetails('919876543210', { ...orderDetails, totalPaise: 1 })).rejects.toThrow(/does not equal/);
    expect(f.calls).toHaveLength(0);
  });

  it('verifies webhook signatures and the subscription token', () => {
    const { wa } = client();
    const raw = '{"object":"whatsapp_business_account"}';
    expect(wa.verifyWebhookSignature(raw, `sha256=${hmacSha256Hex('app-secret', raw)}`)).toBe(true);
    expect(wa.verifyWebhookSignature(raw, `sha256=${hmacSha256Hex('other', raw)}`)).toBe(false);
    expect(wa.verifyWebhookSignature(raw, hmacSha256Hex('app-secret', raw))).toBe(false); // missing prefix
    expect(wa.verifyWebhookSignature(raw, undefined)).toBe(false);
    expect(wa.verifySubscriptionToken('verify-me')).toBe(true);
    expect(wa.verifySubscriptionToken('nope')).toBe(false);
  });
});

describe('validateOrderDetails', () => {
  it('requires subtotal to equal the item total', () => {
    expect(() => validateOrderDetails({ ...orderDetails, subtotalPaise: 30000, totalPaise: 37000 })).toThrow(/item total/);
  });

  it('requires total = subtotal + tax + shipping − discount', () => {
    expect(() => validateOrderDetails({ ...orderDetails, discountPaise: 900, totalPaise: 36000 })).not.toThrow();
    expect(() => validateOrderDetails({ ...orderDetails, discountPaise: 900 })).toThrow(/does not equal/);
  });

  it('requires expiry at least 5 minutes ahead', () => {
    const now = new Date('2026-09-28T10:00:00Z');
    expect(() => validateOrderDetails({ ...orderDetails, expiresAt: new Date('2026-09-28T10:04:00Z') }, now)).toThrow(/5 minutes/);
    expect(() => validateOrderDetails({ ...orderDetails, expiresAt: new Date('2026-09-28T10:06:00Z') }, now)).not.toThrow();
  });

  it('rejects unsafe reference ids', () => {
    expect(() => validateOrderDetails({ ...orderDetails, referenceId: 'has space' })).toThrow(/reference_id/);
  });
});

describe('parseWebhook', () => {
  it('parses a catalogue cart, converting rupee prices to paise', () => {
    const [event] = parseWebhook(cartWebhook('wamid.C1', [{ retailerId: 'QZ-EAR-001', quantity: 2, price: 299 }], { note: 'Gift wrap' }));
    expect(event).toMatchObject({
      kind: 'message',
      profileName: 'Priya',
      message: {
        kind: 'order',
        from: '919876543210',
        order: { catalogId: 'CATALOG_1', note: 'Gift wrap', items: [{ retailerId: 'QZ-EAR-001', quantity: 2, unitPricePaise: 29900 }] },
      },
    });
  });

  it('parses the native address form reply', () => {
    const [event] = parseWebhook(
      addressReplyWebhook('wamid.A1', {
        name: 'Priya Sharma',
        phone_number: '+919876543210',
        in_pin_code: '411001',
        house_number: '12B',
        address: 'MG Road',
        city: 'Pune',
        state: 'Maharashtra',
      }),
    );
    expect(event?.kind === 'message' && event.message.address).toEqual({
      name: 'Priya Sharma',
      phoneNumber: '+919876543210',
      pincode: '411001',
      houseNumber: '12B',
      address: 'MG Road',
      city: 'Pune',
      state: 'Maharashtra',
      floorNumber: undefined,
      towerNumber: undefined,
      buildingName: undefined,
      landmarkArea: undefined,
    });
  });

  it('separates delivery statuses from payment statuses', () => {
    const [status] = parseWebhook(statusWebhook('wamid.S1', 'read'));
    const [payment] = parseWebhook(paymentWebhook('wamid.P1', 'QZPAY-1', 'captured', 36900, 'pay_ABC'));
    expect(status).toMatchObject({ kind: 'status', status: { messageId: 'wamid.S1', status: 'read' } });
    expect(payment).toMatchObject({
      kind: 'payment',
      payment: { referenceId: 'QZPAY-1', status: 'captured', amountPaise: 36900, pgTransactionId: 'pay_ABC' },
    });
  });

  it('ignores payloads that are not WhatsApp business events', () => {
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
  });
});
