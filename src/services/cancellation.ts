import type { Order } from '@prisma/client';
import { env } from '../config/env.js';
import { integrations } from '../integrations/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import * as copy from '../messages/copy.js';
import { recordEvent, type ActorContext } from './audit.js';
import { cancelJobs } from './jobs.js';
import { sendWithFallback, templateComponents, type OutboundMessage } from './messaging.js';
import { activeItems, getOrder, transitionOrder, withTx } from './orders.js';
import { executeRefund, pendingRefunds } from './refunds.js';

/**
 * Order cancellation – before payment (close it and tell the customer), after payment but before
 * pickup (cancel the shipment, return the stock, refund), and after dispatch when the parcel comes
 * back or is lost (close it, optionally refund).
 */

type NotifyKind = 'customer' | 'store' | 'timeout' | 'payment_timeout';

/**
 * Sends the customer a cancellation/refund notice. When a Pay Now request is still open it goes
 * out as an order_status "canceled" update, which also disables that order card's payment button.
 */
export async function notifyCustomer(orderId: string, text: string, templateReason: string, openReference?: string): Promise<string | undefined> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { customer: true } });
  if (!order) throw new NotFoundError('Order', orderId);
  const session: OutboundMessage = openReference
    ? { kind: 'order_status', status: { referenceId: openReference, status: 'canceled', body: text, description: 'Order cancelled' } }
    : { kind: 'text', body: text };
  try {
    await sendWithFallback({
      customer: order.customer,
      orderId,
      session,
      template: () => ({
        name: env.TEMPLATE_ORDER_CANCELLED,
        language: env.WHATSAPP_TEMPLATE_LANGUAGE,
        components: templateComponents([copy.firstName(order.customer.name), order.orderNumber ?? order.requestNumber, templateReason]),
      }),
    });
    return undefined;
  } catch (err) {
    return `The customer could not be notified: ${err instanceof Error ? err.message : err}`;
  }
}

/** Marks open (unpaid) payment requests as cancelled; returns the reference of the one sent to the customer. */
async function closeOpenPaymentRequests(orderId: string, reason: string): Promise<string | undefined> {
  const open = await prisma.payment.findMany({ where: { orderId, status: { in: ['CREATED', 'PENDING', 'FAILED'] } } });
  if (open.length === 0) return undefined;
  await prisma.payment.updateMany({
    where: { id: { in: open.map((p) => p.id) }, status: { in: ['CREATED', 'PENDING', 'FAILED'] } },
    data: { status: 'CANCELLED', failureReason: reason },
  });
  return open.find((p) => p.waMessageId)?.referenceId ?? open[0]!.referenceId;
}

/** Cancels an order that has not been paid, and tells the customer. */
export async function cancelOrder(
  orderId: string,
  ctx: ActorContext & { expectedVersion?: number },
  reason: string,
  notify: NotifyKind,
): Promise<{ order: Order; warning?: string }> {
  const order = await transitionOrder(orderId, 'CANCELLED', { ...ctx, reason });
  await cancelJobs(prisma, orderId);
  const openReference = await closeOpenPaymentRequests(orderId, 'Order cancelled');

  const ref = order.requestNumber;
  const text =
    notify === 'customer'
      ? copy.cancelledByCustomer(ref)
      : notify === 'store'
        ? copy.cancelledByStore(ref)
        : notify === 'payment_timeout'
          ? copy.cancelledPaymentTimeout(ref)
          : copy.cancelledNoResponse(ref);
  const problem = await notifyCustomer(orderId, text, copy.cancelledTemplateReason(notify), openReference);
  return { order, warning: problem ? `Order cancelled. ${problem}` : undefined };
}

// ─────────────────────────────────────────────────────────────
// Paid orders (before pickup)
// ─────────────────────────────────────────────────────────────

/** Paid orders can be cancelled with a refund until the courier picks the parcel up. */
export const REFUNDABLE_STATUSES = ['PAID', 'PROCESSING'] as const;

/**
 * Cancels a paid order before pickup:
 *   1. refuses while the shipment is being created at this very moment (try again shortly);
 *   2. cancels the Shiprocket order(s) – nothing else is touched if that fails;
 *   3. in one transaction: cancels the order, returns the stock, marks the payment REFUND_PENDING;
 *   4. refunds through Razorpay (a failure leaves REFUND_FAILED + "Retry refund", never a lost refund);
 *   5. tells the customer.
 * The fulfilment job re-checks the order before every Shiprocket step, so it stops once the order is
 * cancelled.
 */
export async function cancelPaidOrder(orderId: string, adminId: string, expectedVersion: number, reason: string) {
  const order = await getOrder(prisma, orderId);
  if (!(REFUNDABLE_STATUSES as readonly string[]).includes(order.status)) {
    throw new ConflictError('Only paid orders that have not been picked up yet can be cancelled with a refund');
  }
  if (order.version !== expectedVersion) throw new ConflictError('Order was updated by someone else – reload and try again');

  // 1. No shipment being created right now
  await cancelJobs(prisma, orderId, ['shipment.create']);
  const running = await prisma.scheduledJob.count({ where: { orderId, type: 'shipment.create', status: 'RUNNING' } });
  const creating = await prisma.shipment.count({ where: { orderId, currentStatus: 'CREATING' } });
  if (running > 0 || creating > 0) {
    throw new ConflictError('The shipment is being created in Shiprocket right now – try again in a minute');
  }

  const payment = await prisma.payment.findFirst({ where: { orderId, status: 'CAPTURED' }, orderBy: { verifiedAt: 'asc' } });
  if (!payment?.razorpayPaymentId) throw new ConflictError('No captured payment found to refund');

  // 2. Stop the parcel first – refunding goods that still ship would lose them.
  const shipments = await prisma.shipment.findMany({ where: { orderId, shiprocketOrderId: { not: null }, currentStatus: { not: 'CANCELLED' } } });
  for (const shipment of shipments) {
    try {
      await integrations().shiprocket.cancelOrder(shipment.shiprocketOrderId!);
    } catch (err) {
      throw new ConflictError(
        `Could not cancel Shiprocket order ${shipment.shiprocketOrderId}: ${err instanceof Error ? err.message : err}. Cancel it in Shiprocket, then try again.`,
      );
    }
    await prisma.shipment.update({ where: { id: shipment.id }, data: { currentStatus: 'CANCELLED' } });
  }

  // 3. Cancel, restock and mark the refund as due – atomically, with the version the admin saw.
  await withTx(prisma, async (tx) => {
    await transitionOrder(orderId, 'CANCELLED', { actor: 'ADMIN', actorRef: adminId, reason, expectedVersion }, tx);
    const items = activeItems(order.items).sort((a, b) => (a.productId ?? '').localeCompare(b.productId ?? ''));
    for (const item of items) {
      if (item.productId) await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
    }
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'CAPTURED' },
      data: { status: 'REFUND_PENDING', failureReason: `Order cancelled: ${reason}`.slice(0, 500) },
    });
    if (count === 0) throw new ConflictError('The payment changed meanwhile – reload and try again');
  });
  await cancelJobs(prisma, orderId);

  // 4. Refund
  const refund = await executeRefund(payment.id, `Order cancelled: ${reason}`, { actor: 'ADMIN', actorRef: adminId }, true);
  if (!refund.ok) {
    return { warning: `Order cancelled and stock returned, but the refund failed: ${refund.error}. Use “Retry refund”.` };
  }

  // 5. Tell the customer
  const problem = await notifyCustomer(
    orderId,
    copy.refundInitiated({ orderRef: order.orderNumber ?? order.requestNumber, amountPaise: refund.amountPaise }),
    copy.refundTemplateReason(refund.amountPaise),
  );
  return { warning: problem ? `Refund started and order cancelled. ${problem}` : undefined };
}

/** Admin retries refunds that failed (or were abandoned) for an order. */
export async function retryRefunds(orderId: string, adminId: string) {
  const rows = await pendingRefunds(orderId);
  if (rows.length === 0) throw new ConflictError('There is no failed refund on this order');
  const order = await getOrder(prisma, orderId);
  const problems: string[] = [];
  for (const row of rows) {
    const result = await executeRefund(row.id, row.failureReason ?? 'Refund', { actor: 'ADMIN', actorRef: adminId }, false);
    if (!result.ok) {
      problems.push(result.error);
      continue;
    }
    await notifyCustomer(
      orderId,
      copy.refundIssued({ orderRef: order.orderNumber ?? order.requestNumber, amountPaise: result.amountPaise }),
      copy.refundTemplateReason(result.amountPaise),
    );
  }
  return { warning: problems.length ? `Refund still failing: ${problems.join('; ')}` : undefined };
}

// ─────────────────────────────────────────────────────────────
// After dispatch: returned (RTO) or lost parcels
// ─────────────────────────────────────────────────────────────

export const CLOSABLE_AFTER_DISPATCH = ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] as const;

/**
 * Closes a dispatched order whose parcel will not reach the customer (returned to origin, lost,
 * damaged). Optionally returns the stock (parcel back in hand) and refunds the customer.
 */
export async function closeUndelivered(
  orderId: string,
  opts: { adminId: string; expectedVersion: number; reason: string; restock: boolean; refund: boolean },
) {
  const reason = opts.reason.trim();
  if (!reason) throw new ValidationError('Please give a reason');
  const order = await getOrder(prisma, orderId);
  if (!(CLOSABLE_AFTER_DISPATCH as readonly string[]).includes(order.status)) {
    throw new ConflictError('Only dispatched orders that were not delivered can be closed this way');
  }
  const payment = opts.refund
    ? await prisma.payment.findFirst({ where: { orderId, status: 'CAPTURED' }, orderBy: { verifiedAt: 'asc' } })
    : null;
  if (opts.refund && !payment?.razorpayPaymentId) throw new ConflictError('No captured payment found to refund');

  await withTx(prisma, async (tx) => {
    await transitionOrder(orderId, 'CANCELLED', { actor: 'ADMIN', actorRef: opts.adminId, reason, expectedVersion: opts.expectedVersion }, tx);
    if (opts.restock) {
      const items = activeItems(order.items).sort((a, b) => (a.productId ?? '').localeCompare(b.productId ?? ''));
      for (const item of items) {
        if (item.productId) await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
      }
    }
    if (payment) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUND_PENDING', failureReason: `Not delivered: ${reason}`.slice(0, 500) } });
    }
    await recordEvent(tx, {
      actor: 'ADMIN',
      actorRef: opts.adminId,
      orderId,
      type: 'SHIPMENT_EVENT',
      message: `Closed as not delivered – ${opts.restock ? 'stock returned' : 'stock not returned'}, ${opts.refund ? 'refund issued' : 'no refund'}`,
    });
  });
  await cancelJobs(prisma, orderId);

  if (!payment) return {};
  const refund = await executeRefund(payment.id, `Not delivered: ${reason}`, { actor: 'ADMIN', actorRef: opts.adminId }, true);
  if (!refund.ok) return { warning: `Order closed, but the refund failed: ${refund.error}. Use “Retry refund”.` };
  const problem = await notifyCustomer(
    orderId,
    copy.refundIssued({ orderRef: order.orderNumber ?? order.requestNumber, amountPaise: refund.amountPaise }),
    copy.refundTemplateReason(refund.amountPaise),
  );
  if (problem) logger.warn({ orderId, problem }, 'refund notice not delivered');
  return { warning: problem ? `Refund started. ${problem}` : undefined };
}
