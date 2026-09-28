import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { verifyHmacSha256 } from '../../lib/signature.js';
import type { RazorpayClient, RazorpayOrder, RazorpayPayment, RazorpayPaymentStatus, RazorpayRefund } from './types.js';

export class RazorpayApiError extends AppError {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly razorpayCode?: string,
  ) {
    super(message, 502, 'RAZORPAY_API_ERROR', { httpStatus, razorpayCode });
  }

  get retryable(): boolean {
    return this.httpStatus >= 500 || this.httpStatus === 429;
  }
}

type FetchFn = typeof fetch;
type Json = any;

export interface RazorpayOptions {
  fetchImpl?: FetchFn;
  maxRetries?: number;
  retryDelayMs?: number;
  baseUrl?: string;
}

const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

const notes = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]))
    : {}; // Razorpay returns [] for "no notes"

/** Razorpay REST API (v1) client using Basic auth with the key id / secret. */
export class RazorpayLiveClient implements RazorpayClient {
  readonly mode = 'live' as const;
  private readonly fetchImpl: FetchFn;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly baseUrl: string;

  constructor(
    private readonly env: Env,
    options: RazorpayOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.baseUrl = options.baseUrl ?? 'https://api.razorpay.com/v1';
  }

  private async call(method: 'GET' | 'POST', path: string, body?: object): Promise<Json> {
    const auth = Buffer.from(`${this.env.RAZORPAY_KEY_ID}:${this.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const json = (await res.json().catch(() => ({}))) as Json;
        if (!res.ok) {
          const e = json?.error ?? {};
          throw new RazorpayApiError(`Razorpay: ${e.description ?? res.statusText ?? `HTTP ${res.status}`}`, res.status, e.code);
        }
        return json;
      } catch (err) {
        // Only reads are retried. A refund POST that timed out may still have gone through, so it is
        // never repeated blindly – the caller checks the payment's refunded amount instead.
        const retryable = method === 'GET' && (err instanceof RazorpayApiError ? err.retryable : err instanceof TypeError || isTimeout(err));
        if (!retryable || attempt >= this.maxRetries) throw err;
        logger.warn({ err, path, attempt: attempt + 1 }, 'Razorpay call failed, retrying');
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
      }
    }
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    const p = await this.call('GET', `/payments/${encodeURIComponent(paymentId)}`);
    return {
      id: String(p.id),
      orderId: p.order_id ? String(p.order_id) : null,
      status: String(p.status) as RazorpayPaymentStatus,
      amountPaise: Number(p.amount),
      amountRefundedPaise: Number(p.amount_refunded ?? 0),
      currency: String(p.currency),
      method: p.method ? String(p.method) : null,
      notes: notes(p.notes),
      errorDescription: p.error_description ? String(p.error_description) : null,
      createdAt: new Date(Number(p.created_at) * 1000),
    };
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    const o = await this.call('GET', `/orders/${encodeURIComponent(orderId)}`);
    return {
      id: String(o.id),
      receipt: o.receipt ? String(o.receipt) : null,
      amountPaise: Number(o.amount),
      status: String(o.status),
      notes: notes(o.notes),
    };
  }

  async refundPayment(paymentId: string, amountPaise?: number, refundNotes?: Record<string, string>): Promise<RazorpayRefund> {
    const r = await this.call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
      ...(amountPaise !== undefined ? { amount: amountPaise } : {}),
      speed: 'normal',
      ...(refundNotes ? { notes: refundNotes } : {}),
    });
    return { id: String(r.id), paymentId: String(r.payment_id), amountPaise: Number(r.amount), status: r.status };
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string) {
    return verifyHmacSha256(this.env.RAZORPAY_WEBHOOK_SECRET ?? '', rawBody, signature);
  }
}
