import type { Order, OrderItem, Payment, PaymentStatus, Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { integrations } from '../integrations/index.js';
import type { RazorpayPayment } from '../integrations/razorpay/types.js';
import type { OrderDetailsMessage } from '../integrations/whatsapp/types.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { formatINR } from '../lib/money.js';
import { prisma } from '../lib/prisma.js';
import * as copy from '../messages/copy.js';
import { recordEvent, type ActorContext } from './audit.js';
import { cancelOrder } from './cancellation.js';
import { cancelJobs, registerJobHandler, scheduleJob } from './jobs.js';
import { sendToCustomer, sendWithFallback, templateComponents } from './messaging.js';
import { activeItems, getOrder, transitionOrder, withTx } from './orders.js';
import { executeRefund } from './refunds.js';

/**
 * Native WhatsApp payments (order_details + Pay Now via the Razorpay payment configuration).
 *
 *   admin "Send payment request" → Payment row (CREATED) + order_details → PAYMENT_REQUESTED
 *   customer pays in WhatsApp → payment webhook (WhatsApp and/or Razorpay)
 *   → payment re-fetched from the Razorpay API and checked → PAID (QZ order ID, stock, confirmation)
 *   → shipment job
 *
 * Nothing is ever marked paid from webhook content alone.
 */

const JOB = { reminder: 'payment.reminder', expiry: 'payment.expiry' } as const;
const PAYMENT_JOBS = [JOB.reminder, JOB.expiry];
const HOUR = 60 * 60 * 1000;

/** reference_id for order_details – unique per payment request: QZP-RQ260928001-1 */
export function paymentReference(requestNumber: string, attempt: number): string {
  return `QZP-${requestNumber}-${attempt}`;
}

type OrderForPayment = Order & { items: OrderItem[] };

const fit = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The order_details message. Amounts reconcile exactly (validated again before sending). */
export function buildOrderDetails(order: OrderForPayment, referenceId: string, body: string, expiresAt?: Date): OrderDetailsMessage {
  const items = activeItems(order.items);
  return {
    referenceId,
    body,
    footer: `${env.BRAND_NAME} · Secure payment on WhatsApp`.slice(0, 60),
    // WhatsApp limits item names and descriptions on the order card to 60 characters.
    items: items.map((i) => ({ retailerId: i.retailerId, name: fit(i.name, 60), amountPaise: i.unitPricePaise, quantity: i.quantity })),
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    discountDescription: order.discountPaise ? 'Discount' : undefined,
    shippingPaise: order.shippingPaise,
    shippingDescription: fit(order.shippingPaise === 0 ? 'Free shipping' : (order.shippingCourierName ?? 'Shipping'), 60),
    // With GST-inclusive prices the tax is already inside the item amounts, so 0 is added here.
    taxPaise: order.pricesIncludeGst ? 0 : order.taxPaise,
    taxDescription: order.pricesIncludeGst ? `Inclusive of GST (${formatINR(order.taxPaise)})` : 'GST',
    totalPaise: order.totalPaise,
    expiresAt,
  };
}

async function openPayment(orderId: string): Promise<Payment | null> {
  return prisma.payment.findFirst({ where: { orderId, status: { in: ['CREATED', 'PENDING', 'FAILED'] } }, orderBy: { createdAt: 'desc' } });
}

// ─────────────────────────────────────────────────────────────
// Requesting payment
// ─────────────────────────────────────────────────────────────

/** Admin approved the final amount: create the payment request and send Pay Now. */
export async function requestPayment(orderId: string, ctx: ActorContext & { expectedVersion: number }): Promise<{ order: Order; warning?: string }> {
  const order = await withTx(prisma, async (tx) => {
    const current = await getOrder(tx, orderId);
    const attempt = (await tx.payment.count({ where: { orderId } })) + 1;
    // The transition re-checks everything payment depends on: items, address, shipping quote, total.
    const moved = await transitionOrder(orderId, 'PAYMENT_REQUESTED', { ...ctx, reason: `Payment of ${formatINR(current.totalPaise)} requested` }, tx);
    await tx.payment.create({
      data: { orderId, referenceId: paymentReference(current.requestNumber, attempt), amountPaise: current.totalPaise, status: 'CREATED' },
    });
    return moved;
  });

  const now = Date.now();
  if (env.PAYMENT_REMINDER_HOURS > 0 && (env.PAYMENT_EXPIRY_HOURS === 0 || env.PAYMENT_REMINDER_HOURS < env.PAYMENT_EXPIRY_HOURS)) {
    await scheduleJob(prisma, { type: JOB.reminder, orderId, runAt: new Date(now + env.PAYMENT_REMINDER_HOURS * HOUR) });
  }
  if (env.PAYMENT_EXPIRY_HOURS > 0) {
    await scheduleJob(prisma, { type: JOB.expiry, orderId, runAt: new Date(now + env.PAYMENT_EXPIRY_HOURS * HOUR) });
  }

  try {
    await sendPaymentMessage(orderId, 'request');
    return { order };
  } catch (err) {
    return { order, warning: `Payment requested, but the WhatsApp message failed: ${err instanceof Error ? err.message : err}. Use “Resend WhatsApp message”.` };
  }
}

/** Sends (or re-sends) the open payment request – order_details in the 24h window, otherwise the template. */
export async function sendPaymentMessage(orderId: string, reason: 'request' | 'reminder') {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
  if (!order) throw new NotFoundError('Order', orderId);
  if (order.status !== 'PAYMENT_REQUESTED') throw new ConflictError('This order is not waiting for payment');
  const payment = await openPayment(orderId);
  if (!payment) throw new ConflictError('There is no open payment request for this order');

  const expiresAt =
    env.PAYMENT_EXPIRY_HOURS > 0 && order.paymentRequestedAt
      ? new Date(order.paymentRequestedAt.getTime() + env.PAYMENT_EXPIRY_HOURS * HOUR)
      : undefined;
  // WhatsApp needs the expiry at least 5 minutes ahead; very close to expiry, send without one.
  const usableExpiry = expiresAt && expiresAt.getTime() - Date.now() > 10 * 60 * 1000 ? expiresAt : undefined;

  const result = await sendWithFallback({
    customer: order.customer,
    orderId,
    session: {
      kind: 'order_details',
      order: buildOrderDetails(order, payment.referenceId, copy.paymentRequest(order, reason), usableExpiry),
    },
    template: () => ({
      name: env.TEMPLATE_PAYMENT_REQUEST,
      language: env.WHATSAPP_TEMPLATE_LANGUAGE,
      components: templateComponents(
        copy.paymentTemplateValues({ customerName: order.customer.name, requestNumber: order.requestNumber, totalPaise: order.totalPaise }),
        [`qz:pay:${orderId}:0`],
      ),
    }),
  });
  if (!result.usedTemplate) {
    await prisma.payment.update({ where: { id: payment.id }, data: { waMessageId: result.messageId } });
  }
  return result;
}

/** Admin pulls back a payment request (e.g. to change the discount). The old Pay Now card is disabled. */
export async function withdrawPaymentRequest(orderId: string, ctx: ActorContext & { expectedVersion: number }) {
  const payment = await openPayment(orderId);
  const order = await transitionOrder(orderId, 'READY_FOR_PAYMENT', { ...ctx, reason: 'Payment request withdrawn' });
  await cancelJobs(prisma, orderId, PAYMENT_JOBS);
  if (payment) await prisma.payment.update({ where: { id: payment.id }, data: { status: 'CANCELLED', failureReason: 'Withdrawn by admin' } });

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
  try {
    // order_status "canceled" disables the Pay button on the earlier order card.
    if (payment?.waMessageId) {
      await sendToCustomer({
        customer,
        orderId,
        message: {
          kind: 'order_status',
          status: { referenceId: payment.referenceId, status: 'canceled', body: copy.paymentWithdrawn(order.requestNumber), description: 'Replaced by an updated order' },
        },
      });
    }
    return { order };
  } catch (err) {
    return { order, warning: `Payment request withdrawn, but the customer could not be told: ${err instanceof Error ? err.message : err}` };
  }
}

registerJobHandler(JOB.reminder, async (job) => {
  const order = await getOrder(prisma, job.orderId!);
  if (order.status !== 'PAYMENT_REQUESTED') return;
  await sendPaymentMessage(order.id, 'reminder');
});

registerJobHandler(JOB.expiry, async (job) => {
  const order = await getOrder(prisma, job.orderId!);
  if (order.status !== 'PAYMENT_REQUESTED') return;
  // Pinned to the version checked here: a payment confirmed at the same moment wins.
  await cancelOrder(
    order.id,
    { actor: 'SYSTEM', actorRef: 'payment-expiry', expectedVersion: order.version },
    'Payment not completed in time',
    'payment_timeout',
  );
});

// ─────────────────────────────────────────────────────────────
// Payment confirmation
// ─────────────────────────────────────────────────────────────

export type ConfirmOutcome =
  | { outcome: 'paid'; orderNumber: string }
  | { outcome: 'duplicate' | 'pending' | 'failed' | 'refunded' | 'unknown' };

/** Finds our reference for a Razorpay payment: given directly, in its notes, or as its order's receipt. */
async function resolveReference(rp: RazorpayPayment, hint?: string): Promise<string | undefined> {
  if (hint) return hint;
  if (rp.notes.reference_id) return rp.notes.reference_id;
  if (rp.orderId) {
    const order = await integrations().razorpay.fetchOrder(rp.orderId);
    return order.receipt ?? order.notes.reference_id ?? undefined;
  }
  return undefined;
}

/** Statuses of a payment row that already accounts for a Razorpay payment. */
const SETTLED: PaymentStatus[] = ['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING', 'REFUND_FAILED'];
const OPEN: PaymentStatus[] = ['CREATED', 'PENDING', 'FAILED'];

type Decision =
  | { kind: 'duplicate' | 'pending' }
  | { kind: 'failed'; notify: boolean }
  | { kind: 'refund'; rowId: string; why: string; orderId: string }
  | { kind: 'paid'; order: Order };

/**
 * Applies a payment reported by WhatsApp or Razorpay. Nothing is taken from the webhook itself: the
 * payment is re-fetched from the Razorpay API and must be captured, in INR, for exactly the requested
 * amount, on a request that is still open, for an order still waiting for payment.
 *
 * Every payment produces up to three signals at nearly the same time (WhatsApp payment status,
 * Razorpay payment.captured, Razorpay order.paid). They are serialised on the payment request row:
 * the transaction first writes that row (a row lock on PostgreSQL, the write lock on SQLite), then
 * reads everything fresh and decides. A payment that cannot be applied is marked REFUND_PENDING in
 * that same transaction, so a concurrent signal for it sees it as settled and does nothing.
 */
export async function confirmPayment(input: { razorpayPaymentId: string; referenceId?: string; source: 'whatsapp' | 'razorpay' }): Promise<ConfirmOutcome> {
  const rp = await integrations().razorpay.fetchPayment(input.razorpayPaymentId);
  const referenceId = await resolveReference(rp, input.referenceId);
  const request = referenceId ? await prisma.payment.findUnique({ where: { referenceId } }) : null;
  if (!request) {
    logger.warn({ razorpayPaymentId: rp.id, referenceId }, 'payment for an unknown payment request');
    return { outcome: 'unknown' };
  }
  const source = input.source === 'whatsapp' ? 'WhatsApp' : 'Razorpay';
  const actor: ActorContext = { actor: 'SYSTEM', actorRef: `${input.source}-webhook` };

  const decision = await withTx(prisma, async (tx): Promise<Decision> => {
    // Lock first, then read: whatever a concurrent signal did is visible from here on.
    await tx.payment.updateMany({ where: { id: request.id }, data: { updatedAt: new Date() } });

    const known = await tx.payment.findUnique({ where: { razorpayPaymentId: rp.id } });
    if (known && SETTLED.includes(known.status)) return { kind: 'duplicate' };

    const row = await tx.payment.findUniqueOrThrow({ where: { id: request.id } });
    const order = await getOrder(tx, row.orderId);

    if (rp.status === 'failed') {
      // WhatsApp and Razorpay both report a failed attempt – handle each attempt once.
      if (row.failureReason?.includes(rp.id)) return { kind: 'duplicate' };
      const reason = `${rp.errorDescription ?? 'Payment failed'} (${rp.id})`.slice(0, 500);
      const { count } = await tx.payment.updateMany({
        where: { id: row.id, status: { in: OPEN } },
        data: { status: 'FAILED', failureReason: reason },
      });
      await recordEvent(tx, { ...actor, orderId: order.id, type: 'PAYMENT_EVENT', message: `Payment attempt failed: ${reason}` });
      return { kind: 'failed', notify: count > 0 && order.status === 'PAYMENT_REQUESTED' };
    }
    if (rp.status !== 'captured') {
      await recordEvent(tx, { ...actor, orderId: order.id, type: 'PAYMENT_EVENT', message: `Payment ${rp.id} is ${rp.status} (reported by ${source}) – waiting for capture` });
      return { kind: 'pending' };
    }

    const problem =
      rp.currency !== 'INR'
        ? `currency ${rp.currency}`
        : rp.amountPaise !== row.amountPaise
          ? `amount ${formatINR(rp.amountPaise)} does not match the request of ${formatINR(row.amountPaise)}`
          : row.status === 'CANCELLED'
            ? 'the payment request had been withdrawn or the order cancelled'
            : !OPEN.includes(row.status)
              ? 'this request was already paid'
              : order.status !== 'PAYMENT_REQUESTED'
                ? `the order is ${order.status.toLowerCase().replace(/_/g, ' ')}`
                : row.amountPaise !== order.totalPaise
                  ? 'the order total changed after the request was sent'
                  : null;

    const stray = {
      razorpayPaymentId: rp.id,
      razorpayOrderId: rp.orderId,
      method: rp.method,
      verifiedAt: new Date(),
      status: 'REFUND_PENDING' as const,
      failureReason: `Could not be applied: ${problem}`.slice(0, 500),
    };
    if (problem) {
      // Record the stray payment (on the request row if that row never received a payment,
      // otherwise on a row of its own) – from here on it counts as settled.
      if (!row.razorpayPaymentId && row.status !== 'CAPTURED') {
        await tx.payment.update({ where: { id: row.id }, data: { ...stray, amountPaise: rp.amountPaise } });
        return { kind: 'refund', rowId: row.id, why: problem, orderId: order.id };
      }
      const created = await tx.payment.create({
        data: { ...stray, orderId: order.id, referenceId: `${row.referenceId}-${rp.id}`.slice(0, 190), amountPaise: rp.amountPaise },
      });
      return { kind: 'refund', rowId: created.id, why: problem, orderId: order.id };
    }

    await tx.payment.update({
      where: { id: row.id },
      data: {
        status: 'CAPTURED',
        razorpayPaymentId: rp.id,
        razorpayOrderId: rp.orderId,
        method: rp.method,
        verifiedAt: new Date(),
        failureReason: null,
        rawPayload: { id: rp.id, order_id: rp.orderId, amount: rp.amountPaise, method: rp.method, status: rp.status } as Prisma.InputJsonValue,
      },
    });
    await recordEvent(tx, {
      ...actor,
      orderId: order.id,
      type: 'PAYMENT_EVENT',
      message: `Payment of ${formatINR(rp.amountPaise)} verified with Razorpay (${rp.id}${rp.method ? `, ${rp.method.toUpperCase()}` : ''})`,
      data: { razorpayPaymentId: rp.id, razorpayOrderId: rp.orderId, amountPaise: rp.amountPaise, reportedBy: input.source },
    });
    const paid = await transitionOrder(order.id, 'PAID', { actor: 'SYSTEM', actorRef: 'payment', reason: `Paid via ${source}` }, tx);

    // Stock leaves the shelf once the order is paid. A fixed order (by product) avoids deadlocks
    // between two orders paid at the same moment.
    const items = activeItems(order.items).sort((a, b) => (a.productId ?? '').localeCompare(b.productId ?? ''));
    for (const item of items) {
      if (!item.productId) continue;
      const product = await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
      if (product.stock < 0) {
        await recordEvent(tx, {
          actor: 'SYSTEM',
          orderId: order.id,
          type: 'ERROR',
          message: `Stock for ${product.name} is now ${product.stock} – it was sold elsewhere meanwhile. Check inventory before packing.`,
        });
      }
    }
    return { kind: 'paid', order: paid };
  });

  switch (decision.kind) {
    case 'duplicate':
      return { outcome: 'duplicate' };
    case 'pending':
      return { outcome: 'pending' };
    case 'failed':
      if (decision.notify) await tellPaymentFailed(request.orderId);
      return { outcome: 'failed' };
    case 'refund': {
      await refundStray(decision.rowId, decision.orderId, rp.amountPaise, rp.id, decision.why);
      return { outcome: 'refunded' };
    }
    case 'paid': {
      const order = decision.order;
      await cancelJobs(prisma, order.id, PAYMENT_JOBS);
      await scheduleJob(prisma, { type: 'shipment.create', orderId: order.id, runAt: new Date() });
      await sendConfirmation(order.id, request.referenceId, rp.amountPaise);
      return { outcome: 'paid', orderNumber: order.orderNumber! };
    }
  }
}

/** Refunds a captured payment that could not be applied, and tells the team and the customer. */
async function refundStray(rowId: string, orderId: string, amountPaise: number, razorpayPaymentId: string, why: string) {
  await recordEvent(prisma, {
    actor: 'SYSTEM',
    orderId,
    type: 'ERROR',
    message: `Payment ${razorpayPaymentId} of ${formatINR(amountPaise)} could not be applied (${why}) – refunding it automatically.`.slice(0, 500),
  });
  const result = await executeRefund(rowId, `Payment could not be applied: ${why}`, { actor: 'SYSTEM', actorRef: 'payment' }, true);
  if (!result.ok) return; // REFUND_FAILED alert is on the order, with "Retry refund"
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });
  await sendWithFallback({
    customer: order.customer,
    orderId,
    session: { kind: 'text', body: copy.paymentAutoRefunded(amountPaise) },
    template: () => ({
      name: env.TEMPLATE_ORDER_CANCELLED,
      language: env.WHATSAPP_TEMPLATE_LANGUAGE,
      components: templateComponents([copy.firstName(order.customer.name), order.orderNumber ?? order.requestNumber, copy.refundTemplateReason(amountPaise)]),
    }),
  }).catch((err) => logger.warn({ err }, 'could not notify customer about automatic refund'));
}

async function sendConfirmation(orderId: string, referenceId: string, amountPaise: number) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });
  const text = copy.orderConfirmed({ orderNumber: order.orderNumber!, amountPaise });
  try {
    await sendWithFallback({
      customer: order.customer,
      orderId,
      // order_status also flips the customer's order card to "processing"
      session: { kind: 'order_status', status: { referenceId, status: 'processing', body: text, description: `Order ${order.orderNumber} confirmed` } },
      template: () => ({
        name: env.TEMPLATE_ORDER_CONFIRMED,
        language: env.WHATSAPP_TEMPLATE_LANGUAGE,
        components: templateComponents(copy.orderConfirmedTemplateValues({ customerName: order.customer.name, orderNumber: order.orderNumber!, amountPaise })),
      }),
    });
  } catch (err) {
    // The payment is safely recorded; the failed message shows in the order history.
    logger.error({ err, orderId }, 'payment confirmation message failed');
  }
}

async function tellPaymentFailed(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });
  if (order.status !== 'PAYMENT_REQUESTED') return;
  await sendToCustomer({ customer: order.customer, orderId, message: { kind: 'text', body: copy.paymentFailed() } }).catch((err) =>
    logger.warn({ err }, 'could not tell customer about failed payment'),
  );
}

/** A failed attempt reported by WhatsApp without a Razorpay payment id to look up. */
export async function recordUnverifiableFailure(referenceId: string, reason: string) {
  const payment = await prisma.payment.findUnique({ where: { referenceId } });
  if (!payment) return;
  const { count } = await prisma.payment.updateMany({
    where: { id: payment.id, status: { in: ['CREATED', 'PENDING'] } },
    data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
  });
  await recordEvent(prisma, { actor: 'SYSTEM', orderId: payment.orderId, type: 'PAYMENT_EVENT', message: `Payment attempt failed: ${reason}`.slice(0, 500) });
  if (count > 0 || payment.status === 'FAILED') await tellPaymentFailed(payment.orderId);
}
