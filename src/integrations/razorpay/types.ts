export type RazorpayPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';

export interface RazorpayPayment {
  id: string;
  orderId: string | null;
  status: RazorpayPaymentStatus;
  amountPaise: number;
  /** How much of this payment has already been refunded (paise) */
  amountRefundedPaise: number;
  currency: string;
  method: string | null;
  notes: Record<string, string>;
  errorDescription: string | null;
  createdAt: Date;
}

export interface RazorpayOrder {
  id: string;
  /** For WhatsApp payments this is the reference_id we sent in order_details */
  receipt: string | null;
  amountPaise: number;
  status: string;
  notes: Record<string, string>;
}

export interface RazorpayRefund {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: 'pending' | 'processed' | 'failed';
}

export interface RazorpayClient {
  readonly mode: 'mock' | 'live';
  /** Source of truth for payment status – always re-fetch before marking an order paid. */
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
  fetchOrder(orderId: string): Promise<RazorpayOrder>;
  /** Full refund when amountPaise is omitted */
  refundPayment(paymentId: string, amountPaise?: number, notes?: Record<string, string>): Promise<RazorpayRefund>;
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean;
}
