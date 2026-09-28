import { randomBytes } from 'node:crypto';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { verifyHmacSha256 } from '../../lib/signature.js';
import type { RazorpayClient, RazorpayOrder, RazorpayPayment, RazorpayRefund } from './types.js';

export const MOCK_RAZORPAY_WEBHOOK_SECRET = 'mock_razorpay_webhook_secret';

const mockId = (prefix: string) => `${prefix}_MOCK${randomBytes(7).toString('hex')}`;

/** In-memory Razorpay. `simulatePayment` plays the part of the customer paying inside WhatsApp. */
export class MockRazorpayClient implements RazorpayClient {
  readonly mode = 'mock' as const;
  readonly payments = new Map<string, RazorpayPayment>();
  readonly orders = new Map<string, RazorpayOrder>();
  readonly refunds: RazorpayRefund[] = [];

  simulatePayment(input: {
    amountPaise: number;
    referenceId: string;
    outcome?: 'captured' | 'failed' | 'authorized';
    method?: string;
  }): RazorpayPayment {
    const outcome = input.outcome ?? 'captured';
    // WhatsApp creates a Razorpay order per payment request, with our reference as its receipt.
    const order: RazorpayOrder = {
      id: mockId('order'),
      receipt: input.referenceId,
      amountPaise: input.amountPaise,
      status: outcome === 'captured' ? 'paid' : 'attempted',
      notes: { reference_id: input.referenceId },
    };
    this.orders.set(order.id, order);
    const payment: RazorpayPayment = {
      id: mockId('pay'),
      orderId: order.id,
      status: outcome,
      amountPaise: input.amountPaise,
      amountRefundedPaise: 0,
      currency: 'INR',
      method: input.method ?? 'upi',
      notes: {},
      errorDescription: outcome === 'failed' ? 'Payment was declined by the bank (mock)' : null,
      createdAt: new Date(),
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async fetchPayment(paymentId: string) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new NotFoundError('Razorpay payment', paymentId);
    return { ...payment };
  }

  async fetchOrder(orderId: string) {
    const order = this.orders.get(orderId);
    if (!order) throw new NotFoundError('Razorpay order', orderId);
    return { ...order };
  }

  async refundPayment(paymentId: string, amountPaise?: number) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new NotFoundError('Razorpay payment', paymentId);
    if (payment.status !== 'captured' && payment.status !== 'refunded') throw new ValidationError(`Cannot refund a ${payment.status} payment`);
    const amount = amountPaise ?? payment.amountPaise;
    if (amount > payment.amountPaise) throw new ValidationError('Refund exceeds payment amount');
    const refund: RazorpayRefund = { id: mockId('rfnd'), paymentId, amountPaise: amount, status: 'processed' };
    if (payment.amountRefundedPaise + amount > payment.amountPaise) throw new ValidationError('The payment has already been fully refunded');
    this.refunds.push(refund);
    payment.amountRefundedPaise += amount;
    if (payment.amountRefundedPaise === payment.amountPaise) payment.status = 'refunded';
    return refund;
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string) {
    return verifyHmacSha256(MOCK_RAZORPAY_WEBHOOK_SECRET, rawBody, signature);
  }

  reset() {
    this.payments.clear();
    this.orders.clear();
    this.refunds.length = 0;
  }
}
