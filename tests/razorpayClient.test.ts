import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { RazorpayLiveClient } from '../src/integrations/razorpay/live.js';
import { hmacSha256Hex } from '../src/lib/signature.js';

const liveEnv = { ...env, RAZORPAY_KEY_ID: 'rzp_test_KEY', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsec' };

function client(replies: { status: number; body: object }[]) {
  const calls: { url: string; method: string; auth: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      auth: (init.headers as Record<string, string>).Authorization!,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies.shift()!;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { calls, rz: new RazorpayLiveClient(liveEnv, { fetchImpl, retryDelayMs: 1 }) };
}

describe('RazorpayLiveClient', () => {
  it('fetches a payment with Basic auth and maps it', async () => {
    const { calls, rz } = client([
      {
        status: 200,
        body: { id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 71700, currency: 'INR', method: 'upi', notes: [], created_at: 1790000000 },
      },
    ]);
    const p = await rz.fetchPayment('pay_1');
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/payments/pay_1');
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('rzp_test_KEY:secret').toString('base64')}`);
    expect(p).toMatchObject({ id: 'pay_1', orderId: 'order_1', status: 'captured', amountPaise: 71700, method: 'upi', notes: {} });
  });

  it('reads the receipt from a Razorpay order', async () => {
    const { rz } = client([{ status: 200, body: { id: 'order_1', receipt: 'QZP-RQ260928001-1', amount: 71700, status: 'paid', notes: { reference_id: 'QZP-RQ260928001-1' } } }]);
    expect(await rz.fetchOrder('order_1')).toEqual({
      id: 'order_1',
      receipt: 'QZP-RQ260928001-1',
      amountPaise: 71700,
      status: 'paid',
      notes: { reference_id: 'QZP-RQ260928001-1' },
    });
  });

  it('issues a full refund at normal speed with notes', async () => {
    const { calls, rz } = client([{ status: 200, body: { id: 'rfnd_1', payment_id: 'pay_1', amount: 71700, status: 'processed' } }]);
    const r = await rz.refundPayment('pay_1', undefined, { order: 'QZ260928001' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.razorpay.com/v1/payments/pay_1/refund', body: { speed: 'normal', notes: { order: 'QZ260928001' } } });
    expect(r).toEqual({ id: 'rfnd_1', paymentId: 'pay_1', amountPaise: 71700, status: 'processed' });
  });

  it('surfaces Razorpay error descriptions and retries server errors', async () => {
    const { rz } = client([
      { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The payment has already been fully refunded' } } },
      { status: 503, body: {} },
      { status: 200, body: { id: 'pay_2', status: 'captured', amount: 100, currency: 'INR', notes: {} } },
    ]);
    await expect(rz.refundPayment('pay_1')).rejects.toThrow('The payment has already been fully refunded');
    expect((await rz.fetchPayment('pay_2')).id).toBe('pay_2');
  });

  it('verifies webhook signatures with the webhook secret', () => {
    const { rz } = client([]);
    const raw = '{"event":"payment.captured"}';
    expect(rz.verifyWebhookSignature(raw, hmacSha256Hex('whsec', raw))).toBe(true);
    expect(rz.verifyWebhookSignature(raw, hmacSha256Hex('secret', raw))).toBe(false);
  });
});
