import { logger } from '../lib/logger.js';
import { formatINR } from '../lib/money.js';
import { prisma } from '../lib/prisma.js';
import { recordEvent } from './audit.js';
import { confirmPayment } from './payments.js';
import { claimWebhook, processClaimed } from './webhooks.js';

type Json = any;

/**
 * Razorpay webhooks – a second, independent signal next to WhatsApp's payment status.
 * Subscribe to: payment.captured, payment.failed, order.paid, refund.processed, refund.failed.
 */
export async function processRazorpayWebhook(body: Json, eventId: string | undefined): Promise<'processed' | 'duplicate' | 'ignored' | 'failed'> {
  const event = String(body?.event ?? '');
  const payment = body?.payload?.payment?.entity;
  const refund = body?.payload?.refund?.entity;

  const handler = (() => {
    if (['payment.captured', 'payment.failed', 'order.paid'].includes(event) && payment?.id) {
      return () =>
        confirmPayment({
          razorpayPaymentId: String(payment.id),
          referenceId: payment.notes?.reference_id ? String(payment.notes.reference_id) : undefined,
          source: 'razorpay',
        }).then(() => undefined);
    }
    if ((event === 'refund.processed' || event === 'refund.failed') && refund?.id) {
      return () => recordRefundUpdate(event, refund);
    }
    return null;
  })();
  if (!handler) return 'ignored';

  // Razorpay sends a unique X-Razorpay-Event-Id; fall back to event + entity id.
  const externalId = eventId ?? `${event}:${payment?.id ?? refund?.id}`;
  const claimed = await claimWebhook('razorpay', externalId, event, body);
  if (!claimed) return 'duplicate';
  return (await processClaimed(claimed, `razorpay.${event}`, handler)) ? 'processed' : 'failed';
}

async function recordRefundUpdate(event: string, refund: Json) {
  const payment = await prisma.payment.findFirst({
    where: { OR: [{ razorpayRefundId: String(refund.id) }, { razorpayPaymentId: String(refund.payment_id) }] },
  });
  if (!payment) {
    logger.warn({ refundId: refund.id }, 'refund webhook for an unknown payment');
    return;
  }
  const ok = event === 'refund.processed';
  await recordEvent(prisma, {
    actor: 'SYSTEM',
    actorRef: 'razorpay-webhook',
    orderId: payment.orderId,
    type: ok ? 'PAYMENT_EVENT' : 'ERROR',
    message: ok
      ? `Refund ${refund.id} of ${formatINR(Number(refund.amount))} processed by Razorpay`
      : `Refund ${refund.id} FAILED at Razorpay – retry it from the Razorpay dashboard`,
  });
}
