import type { Order, OrderItem, OrderStatus, Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { canTransition, isEditable, STATUS_TIMESTAMP } from '../domain/orderStatus.js';
import { calculateTotals } from '../domain/pricing.js';
import { ConflictError, InvalidTransitionError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { formatINR } from '../lib/money.js';
import { prisma, type Db, type Tx } from '../lib/prisma.js';
import { recordEvent, type ActorContext } from './audit.js';
import { nextOrderNumber, nextRequestNumber } from './sequence.js';

type OrderWithItems = Order & { items: OrderItem[] };

/** Runs `fn` inside a transaction, joining the caller's transaction if one is already open. */
export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return '$transaction' in db ? db.$transaction(fn) : fn(db);
}

export async function getOrder(db: Db, orderId: string): Promise<OrderWithItems> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } }, // ids break createdAt ties (time-ordered cuids)
  });
  if (!order) throw new NotFoundError('Order', orderId);
  return order;
}

export function activeItems(items: OrderItem[]): OrderItem[] {
  return items.filter((i) => !i.removed && i.quantity > 0);
}

/** True when the order differs from what the customer put in their cart. */
export function isModifiedFromRequest(items: OrderItem[]): boolean {
  return items.some((i) => i.addedByAdmin || i.removed || i.quantity !== i.requestedQuantity);
}

// ─────────────────────────────────────────────────────────────
// Creating an order request (from a WhatsApp catalogue cart)
// ─────────────────────────────────────────────────────────────

export interface OrderRequestInput {
  waId: string;
  customerName?: string;
  catalogId?: string;
  customerNote?: string;
  inboundMessageId?: string;
  rawRequest?: Prisma.InputJsonValue;
  items: { retailerId: string; quantity: number; unitPricePaise?: number }[];
}

/**
 * Stores a customer's cart as a NEW order awaiting admin review. No payment is requested here.
 * Idempotent on `inboundMessageId` – WhatsApp may deliver the same webhook more than once.
 */
export async function createOrderRequest(input: OrderRequestInput, db: Db = prisma): Promise<OrderWithItems> {
  if (input.items.length === 0) throw new ValidationError('Order request has no items');

  return withTx(db, async (tx) => {
    if (input.inboundMessageId) {
      const existing = await tx.order.findUnique({
        where: { inboundMessageId: input.inboundMessageId },
        include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      });
      if (existing) return existing;
    }

    const customer = await tx.customer.upsert({
      where: { waId: input.waId },
      create: { waId: input.waId, name: input.customerName },
      update: input.customerName ? { name: input.customerName } : {},
    });

    const products = await tx.product.findMany({
      where: { retailerId: { in: input.items.map((i) => i.retailerId) } },
    });
    const byRetailerId = new Map(products.map((p) => [p.retailerId, p]));

    const warnings: string[] = [];
    const lines = input.items.map((item) => {
      const product = byRetailerId.get(item.retailerId);
      if (!product) {
        warnings.push(`Unknown catalogue item ${item.retailerId}`);
      } else if (item.unitPricePaise !== undefined && item.unitPricePaise !== product.pricePaise) {
        warnings.push(
          `Price mismatch for ${product.sku}: catalogue ${item.unitPricePaise}, system ${product.pricePaise}`,
        );
      }
      // The customer is charged the price they saw in the catalogue; mismatches are flagged for admin.
      const unitPricePaise = item.unitPricePaise ?? product?.pricePaise ?? 0;
      return {
        productId: product?.id,
        sku: product?.sku ?? item.retailerId,
        retailerId: item.retailerId,
        name: product?.name ?? `Unknown item (${item.retailerId})`,
        unitPricePaise,
        gstRateBps: product?.gstRateBps ?? env.DEFAULT_GST_RATE_BPS,
        requestedQuantity: item.quantity,
        quantity: item.quantity,
      };
    });

    const totals = calculateTotals({ lines, pricesIncludeGst: env.PRICES_INCLUDE_GST });

    const order = await tx.order.create({
      data: {
        requestNumber: await nextRequestNumber(tx),
        customerId: customer.id,
        catalogId: input.catalogId,
        customerNote: input.customerNote,
        inboundMessageId: input.inboundMessageId,
        rawRequest: input.rawRequest,
        pricesIncludeGst: env.PRICES_INCLUDE_GST,
        subtotalPaise: totals.subtotalPaise,
        taxPaise: totals.taxPaise,
        totalPaise: totals.totalPaise,
        items: { create: lines },
      },
      include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });

    const ctx: ActorContext = { actor: 'CUSTOMER', actorRef: input.waId };
    await recordEvent(tx, {
      ...ctx,
      orderId: order.id,
      type: 'CREATED',
      toStatus: 'NEW',
      message: `Order request ${order.requestNumber} received with ${lines.length} item(s)`,
    });
    for (const warning of warnings) {
      await recordEvent(tx, { actor: 'SYSTEM', orderId: order.id, type: 'ERROR', message: warning });
    }
    return order;
  });
}

// ─────────────────────────────────────────────────────────────
// Totals
// ─────────────────────────────────────────────────────────────

/** Recomputes subtotal/tax/total from the current items, discount and shipping. */
export async function recalculateTotals(db: Db, orderId: string, ctx: ActorContext): Promise<Order> {
  return withTx(db, async (tx) => {
    const order = await getOrder(tx, orderId);
    const totals = calculateTotals({
      lines: activeItems(order.items),
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      pricesIncludeGst: order.pricesIncludeGst,
    });

    const changed =
      totals.subtotalPaise !== order.subtotalPaise ||
      totals.taxPaise !== order.taxPaise ||
      totals.totalPaise !== order.totalPaise;
    if (!changed) return order;

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        subtotalPaise: totals.subtotalPaise,
        taxPaise: totals.taxPaise,
        totalPaise: totals.totalPaise,
        version: { increment: 1 },
      },
    });
    await recordEvent(tx, {
      ...ctx,
      orderId,
      type: 'TOTALS_RECALCULATED',
      message: `Total ${formatINR(order.totalPaise)} → ${formatINR(totals.totalPaise)}`,
      data: {
        before: { subtotal: order.subtotalPaise, tax: order.taxPaise, total: order.totalPaise },
        after: { subtotal: totals.subtotalPaise, tax: totals.taxPaise, total: totals.totalPaise },
      },
    });
    return updated;
  });
}

// ─────────────────────────────────────────────────────────────
// Status transitions
// ─────────────────────────────────────────────────────────────

export interface TransitionOptions extends ActorContext {
  reason?: string;
  data?: Prisma.InputJsonValue;
  /** Version the caller last saw (admin UI). Rejects the change if someone else updated the order first. */
  expectedVersion?: number;
}

function addressComplete(order: Order): boolean {
  return Boolean(
    order.shipName &&
      order.shipPhone &&
      order.shipHouse &&
      order.shipStreet &&
      order.shipCity &&
      order.shipState &&
      order.shipPincode &&
      /^\d{6}$/.test(order.shipPincode),
  );
}

/** Business rules that must hold before an order may enter a status. Returns a reason when blocked. */
async function checkPreconditions(tx: Tx, order: OrderWithItems, to: OrderStatus): Promise<string | undefined> {
  const items = activeItems(order.items);

  switch (to) {
    case 'AWAITING_CUSTOMER_APPROVAL':
      if (items.length === 0) return 'order has no items';
      if (!isModifiedFromRequest(order.items)) return 'order is unchanged – approve it directly instead';
      return;

    case 'AWAITING_ADDRESS':
      if (items.length === 0) return 'order has no items';
      // Admin may only approve directly when nothing changed; any change needs customer approval first.
      if ((order.status === 'NEW' || order.status === 'PENDING_REVIEW') && isModifiedFromRequest(order.items)) {
        return 'order was modified – customer approval is required';
      }
      return;

    case 'READY_FOR_PAYMENT':
    case 'PAYMENT_REQUESTED': {
      if (items.length === 0) return 'order has no items';
      if (!addressComplete(order)) return 'delivery address is incomplete';
      if (!order.shippingQuotedAt) return 'shipping has not been calculated';
      const totals = calculateTotals({
        lines: items,
        discountPaise: order.discountPaise,
        shippingPaise: order.shippingPaise,
        pricesIncludeGst: order.pricesIncludeGst,
      });
      if (totals.totalPaise !== order.totalPaise) return 'stored total is out of date – recalculate first';
      if (order.totalPaise <= 0) return 'total must be greater than zero';
      return;
    }

    case 'PAID': {
      const verified = await tx.payment.findFirst({
        where: { orderId: order.id, status: 'CAPTURED', verifiedAt: { not: null }, amountPaise: order.totalPaise },
      });
      if (!verified) return 'no verified payment for the full order amount';
      return;
    }

    case 'PROCESSING':
      if (!order.orderNumber) return 'order number has not been assigned';
      return;

    default:
      return;
  }
}

/**
 * The single entry point for changing an order's status.
 * Validates the transition table and business preconditions, stamps lifecycle timestamps,
 * and writes the audit event – all in one transaction with optimistic locking.
 */
export async function transitionOrder(
  orderId: string,
  to: OrderStatus,
  opts: TransitionOptions,
  db: Db = prisma,
): Promise<Order> {
  return withTx(db, async (tx) => {
    const order = await getOrder(tx, orderId);
    const from = order.status;

    if (opts.expectedVersion !== undefined && opts.expectedVersion !== order.version) {
      throw new ConflictError('Order was updated by someone else – reload and try again', {
        expectedVersion: opts.expectedVersion,
        currentVersion: order.version,
      });
    }
    if (!canTransition(from, to, opts.actor)) {
      throw new InvalidTransitionError(from, to, opts.actor);
    }
    const blocked = await checkPreconditions(tx, order, to);
    if (blocked) throw new InvalidTransitionError(from, to, opts.actor, blocked);

    const data: Prisma.OrderUpdateManyMutationInput = { status: to, version: { increment: 1 } };
    const stampField = STATUS_TIMESTAMP[to];
    if (stampField) (data as Record<string, unknown>)[stampField] = new Date();

    if (to === 'CANCELLED') data.cancelReason = opts.reason ?? null;
    // Going back to address collection invalidates the old shipping quote.
    if (to === 'AWAITING_ADDRESS') data.shippingQuotedAt = null;
    if (to === 'PAID' && !order.orderNumber) data.orderNumber = await nextOrderNumber(tx);

    const { count } = await tx.order.updateMany({
      where: { id: orderId, version: order.version, status: from },
      data,
    });
    if (count === 0) throw new ConflictError('Order changed while it was being updated – try again');

    await recordEvent(tx, {
      actor: opts.actor,
      actorRef: opts.actorRef,
      orderId,
      type: 'STATUS_CHANGED',
      fromStatus: from,
      toStatus: to,
      message: opts.reason,
      data: opts.data,
    });

    logger.info({ orderId, from, to, actor: opts.actor }, 'order status changed');
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

export function assertEditable(order: Order): void {
  if (!isEditable(order.status)) {
    throw new ConflictError(`Order items can no longer be changed (status ${order.status})`);
  }
}
