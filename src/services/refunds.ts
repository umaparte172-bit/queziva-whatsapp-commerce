import type { Payment } from '@prisma/client';
import { integrations } from '../integrations/index.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { formatINR } from '../lib/money.js';
import { prisma } from '../lib/prisma.js';
import { recordEvent, type ActorContext } from './audit.js';

/**
 * Refunds, one payment row at a time. The row is marked REFUND_PENDING (in the caller's
 * transaction) *before* Razorpay is called, so a refund is never forgotten and never repeated:
 *
 *   REFUND_PENDING ──refund ok──► REFUNDED
 *        │
 *        └──error──► REFUND_FAILED ──"Retry refund"──► REFUND_PENDING …
 *
 * Before refunding, the payment is looked up at Razorpay: if it was already refunded (e.g. an
 * earlier attempt timed out after Razorpay processed it), it is only marked REFUNDED.
 */

/** A REFUND_PENDING row untouched this long is treated as abandoned (process crashed mid-refund). */
const STALE_PENDING_MS = 10 * 60 * 1000;

export type RefundOutcome = { ok: true; refundId: string | null; amountPaise: number } | { ok: false; error: string };

/**
 * @param justMarked true when the caller has just marked the row REFUND_PENDING itself (first
 *   attempt). Retries (justMarked false) may only take REFUND_FAILED rows, or REFUND_PENDING rows
 *   that were abandoned – never a refund another process is working on right now.
 */
export async function executeRefund(paymentRowId: string, reason: string, actor: ActorContext, justMarked: boolean): Promise<RefundOutcome> {
  const row = await prisma.payment.findUnique({ where: { id: paymentRowId } });
  if (!row) throw new NotFoundError('Payment', paymentRowId);
  if (!row.razorpayPaymentId) throw new ConflictError('This payment has no Razorpay payment to refund');
  if (row.status === 'REFUNDED') return { ok: true, refundId: row.razorpayRefundId, amountPaise: row.refundedPaise };
  if (row.status !== 'REFUND_PENDING' && row.status !== 'REFUND_FAILED') {
    throw new ConflictError(`This payment is ${row.status.toLowerCase()}, not waiting for a refund`);
  }
  const abandoned = row.status === 'REFUND_PENDING' && row.updatedAt.getTime() < Date.now() - STALE_PENDING_MS;
  if (!justMarked && row.status === 'REFUND_PENDING' && !abandoned) {
    return { ok: false, error: 'This refund is already being processed' };
  }

  // Claim: only one process works on a refund at a time (the write changes updatedAt, so a
  // concurrent claim of the same row matches nothing).
  const { count } = await prisma.payment.updateMany({
    where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
    data: { status: 'REFUND_PENDING' },
  });
  if (count === 0) return { ok: false, error: 'This refund is already being processed' };

  const razorpay = integrations().razorpay;
  try {
    const rp = await razorpay.fetchPayment(row.razorpayPaymentId);
    const remaining = row.amountPaise - rp.amountRefundedPaise;
    let refundId: string | null = row.razorpayRefundId;
    let message: string;
    if (remaining > 0) {
      const refund = await razorpay.refundPayment(row.razorpayPaymentId, remaining, { reason: reason.slice(0, 250) });
      refundId = refund.id;
      const partOf = remaining < row.amountPaise ? ` (the rest of ${formatINR(row.amountPaise)})` : '';
      message = `Refund of ${formatINR(remaining)}${partOf} for ${row.razorpayPaymentId} initiated (${refund.id})`;
    } else {
      // Nothing left to refund: an earlier attempt went through at Razorpay after all.
      message = `${formatINR(row.amountPaise)} for ${row.razorpayPaymentId} was already refunded at Razorpay – marked as refunded`;
    }
    await prisma.payment.update({
      where: { id: row.id },
      data: { status: 'REFUNDED', refundedPaise: row.amountPaise, razorpayRefundId: refundId },
    });
    await recordEvent(prisma, {
      ...actor,
      orderId: row.orderId,
      type: 'PAYMENT_EVENT',
      message,
      data: { paymentId: row.razorpayPaymentId, refundId, amountPaise: row.amountPaise, newlyRefundedPaise: Math.max(remaining, 0) },
    });
    return { ok: true, refundId, amountPaise: row.amountPaise };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, paymentRowId, razorpayPaymentId: row.razorpayPaymentId }, 'refund failed');
    await prisma.payment.update({ where: { id: row.id }, data: { status: 'REFUND_FAILED', failureReason: `${reason} – refund failed: ${error}`.slice(0, 500) } });
    await recordEvent(prisma, {
      actor: 'SYSTEM',
      orderId: row.orderId,
      type: 'ERROR',
      message: `Refund of ${formatINR(row.amountPaise)} for ${row.razorpayPaymentId} FAILED: ${error}. Use “Retry refund”, or refund it in the Razorpay dashboard.`.slice(0, 500),
    });
    return { ok: false, error };
  }
}

/** Payments of an order that still need their refund completed (shown as "Retry refund"). */
export function pendingRefunds(orderId: string): Promise<Payment[]> {
  return prisma.payment.findMany({
    where: {
      orderId,
      OR: [{ status: 'REFUND_FAILED' }, { status: 'REFUND_PENDING', updatedAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } }],
    },
  });
}
