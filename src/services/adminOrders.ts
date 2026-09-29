import { allMocked } from '../config/env.js';
import type { Order, OrderItem, OrderStatus, Prisma, Product } from '@prisma/client';
import { EDITABLE_STATUSES, isPaid, STATUS_LABELS } from '../domain/orderStatus.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { formatINR } from '../lib/money.js';
import { containsText, prisma, type Tx } from '../lib/prisma.js';
import { recordEvent, type ActorContext } from './audit.js';
import { cancelOrder, cancelPaidOrder, CLOSABLE_AFTER_DISPATCH, REFUNDABLE_STATUSES, retryRefunds } from './cancellation.js';
import { afterAdminApproval, resendCurrentRequest } from './customerFlow.js';
import { cancelJobs } from './jobs.js';
import { createShipment, shipmentIncomplete } from './fulfilment.js';
import { pendingRefunds } from './refunds.js';
import { requestPayment, withdrawPaymentRequest } from './payments.js';
import { quoteShipping, reapplyShippingRules } from './shipping.js';
import { markDelivered, refreshTracking } from './tracking.js';
import {
  activeItems,
  getOrder,
  isModifiedFromRequest,
  recalculateTotals,
  transitionOrder,
  withTx,
} from './orders.js';

/**
 * Admin operations on orders: item edits, discount, notes and review actions.
 * Every change checks the version the admin last saw, so two people editing the
 * same order cannot silently overwrite each other.
 */

export interface AdminContext {
  adminId: string;
  expectedVersion: number;
}

/** Discount can still be adjusted during the final amount review, before payment is requested. */
const DISCOUNT_STATUSES: readonly OrderStatus[] = [...EDITABLE_STATUSES, 'AWAITING_ADDRESS', 'READY_FOR_PAYMENT'];

/** Orders that have not been approved yet – where stock problems matter. */
export const OPEN_REVIEW_STATUSES: readonly OrderStatus[] = [
  'NEW',
  'PENDING_REVIEW',
  'MODIFIED',
  'AWAITING_CUSTOMER_APPROVAL',
];

const actor = (ctx: AdminContext): ActorContext => ({ actor: 'ADMIN', actorRef: ctx.adminId });

type ItemWithProduct = OrderItem & { product: Product | null };

// ─────────────────────────────────────────────────────────────
// Stock
// ─────────────────────────────────────────────────────────────

export interface StockProblem {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  available: number;
  reason: 'insufficient_stock' | 'unknown_product' | 'inactive_product';
}

export function stockProblems(items: ItemWithProduct[]): StockProblem[] {
  const problems: StockProblem[] = [];
  for (const item of activeItems(items) as ItemWithProduct[]) {
    const base = { itemId: item.id, sku: item.sku, name: item.name, quantity: item.quantity };
    if (!item.product) problems.push({ ...base, available: 0, reason: 'unknown_product' });
    else if (!item.product.active) problems.push({ ...base, available: item.product.stock, reason: 'inactive_product' });
    else if (item.quantity > item.product.stock) {
      problems.push({ ...base, available: item.product.stock, reason: 'insufficient_stock' });
    }
  }
  return problems;
}

export function describeStockProblem(p: StockProblem): string {
  switch (p.reason) {
    case 'unknown_product':
      return `${p.name} is not in the product list`;
    case 'inactive_product':
      return `${p.name} is marked inactive`;
    case 'insufficient_stock':
      return `${p.name}: ${p.quantity} requested, only ${p.available} in stock`;
  }
}

// ─────────────────────────────────────────────────────────────
// Shared edit plumbing
// ─────────────────────────────────────────────────────────────

async function lockForEdit(tx: Tx, orderId: string, ctx: AdminContext, allowed: readonly OrderStatus[]) {
  const order = await getOrder(tx, orderId);
  if (!allowed.includes(order.status)) {
    throw new ConflictError(`This order can no longer be changed (${STATUS_LABELS[order.status]})`);
  }
  // Claim the version up front: a concurrent edit makes this update match nothing.
  const { count } = await tx.order.updateMany({
    where: { id: orderId, version: ctx.expectedVersion },
    data: { version: { increment: 1 } },
  });
  if (count === 0) throw new ConflictError('Order was updated by someone else – reload and try again');
  return order;
}

/** Recalculates totals and keeps the status in step with whether the order still matches the request. */
async function afterItemsChanged(tx: Tx, orderId: string, ctx: AdminContext): Promise<void> {
  await recalculateTotals(tx, orderId, actor(ctx));
  const order = await getOrder(tx, orderId);
  const modified = isModifiedFromRequest(order.items);

  // Editing a revised order the customer has not answered yet withdraws that version:
  // its reminders stop, and its buttons are rejected because the next send starts a new round.
  if (order.status === 'AWAITING_CUSTOMER_APPROVAL') {
    await cancelJobs(tx, orderId, ['approval.reminder', 'approval.timeout']);
  }

  if (modified && ['NEW', 'PENDING_REVIEW', 'AWAITING_CUSTOMER_APPROVAL'].includes(order.status)) {
    await transitionOrder(orderId, 'MODIFIED', { ...actor(ctx), reason: 'Items changed by admin' }, tx);
  } else if (!modified && order.status === 'MODIFIED') {
    await transitionOrder(orderId, 'PENDING_REVIEW', { ...actor(ctx), reason: 'Order matches the customer request again' }, tx);
  } else if (!modified && order.status === 'AWAITING_CUSTOMER_APPROVAL') {
    await transitionOrder(orderId, 'MODIFIED', actor(ctx), tx);
    await transitionOrder(orderId, 'PENDING_REVIEW', { ...actor(ctx), reason: 'Order matches the customer request again' }, tx);
  }
}

function assertQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new ValidationError('Quantity must be a whole number between 1 and 999');
  }
}

async function findItem(tx: Tx, orderId: string, itemId: string) {
  const item = await tx.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new NotFoundError('Order item', itemId);
  return item;
}

async function findActiveProduct(tx: Tx, productId: string) {
  const product = await tx.product.findUnique({ where: { id: productId } });
  if (!product) throw new NotFoundError('Product', productId);
  if (!product.active) throw new ValidationError(`${product.name} is inactive`);
  return product;
}

// ─────────────────────────────────────────────────────────────
// Item edits
// ─────────────────────────────────────────────────────────────

export function setItemQuantity(orderId: string, itemId: string, quantity: number, ctx: AdminContext) {
  assertQuantity(quantity);
  return withTx(prisma, async (tx) => {
    await lockForEdit(tx, orderId, ctx, EDITABLE_STATUSES);
    const item = await findItem(tx, orderId, itemId);
    if (item.removed) throw new ValidationError('This item was removed – add the product again instead');
    if (item.quantity === quantity) return;

    await tx.orderItem.update({ where: { id: itemId }, data: { quantity } });
    await recordEvent(tx, {
      ...actor(ctx),
      orderId,
      type: 'ITEM_UPDATED',
      message: `${item.name}: quantity ${item.quantity} → ${quantity}`,
      data: { itemId, sku: item.sku, from: item.quantity, to: quantity, requested: item.requestedQuantity },
    });
    await afterItemsChanged(tx, orderId, ctx);
  });
}

export function removeItem(orderId: string, itemId: string, ctx: AdminContext) {
  return withTx(prisma, async (tx) => {
    const order = await lockForEdit(tx, orderId, ctx, EDITABLE_STATUSES);
    const item = await findItem(tx, orderId, itemId);
    if (item.removed) return;
    if (activeItems(order.items).length <= 1) {
      throw new ValidationError('This is the last item – cancel the order instead of removing it');
    }

    await tx.orderItem.update({ where: { id: itemId }, data: { removed: true, quantity: 0 } });
    await recordEvent(tx, {
      ...actor(ctx),
      orderId,
      type: 'ITEM_REMOVED',
      message: `Removed ${item.name} (was × ${item.quantity})`,
      data: { itemId, sku: item.sku, quantity: item.quantity },
    });
    await afterItemsChanged(tx, orderId, ctx);
  });
}

export function addItem(orderId: string, productId: string, quantity: number, ctx: AdminContext) {
  assertQuantity(quantity);
  return withTx(prisma, async (tx) => {
    const order = await lockForEdit(tx, orderId, ctx, EDITABLE_STATUSES);
    const product = await findActiveProduct(tx, productId);

    const lines = order.items.filter((i) => i.productId === product.id);
    if (lines.some((i) => !i.removed)) {
      throw new ValidationError(`${product.name} is already in this order – change its quantity instead`);
    }
    // Prefer the customer's original line (keeps their requested quantity on it).
    const existing = lines.find((i) => i.requestedQuantity > 0) ?? lines[0];

    if (existing) {
      // Bring back a line that was removed earlier (keeps the customer's original request on it).
      await tx.orderItem.update({ where: { id: existing.id }, data: { removed: false, quantity } });
    } else {
      await tx.orderItem.create({
        data: {
          orderId,
          productId: product.id,
          sku: product.sku,
          retailerId: product.retailerId,
          name: product.name,
          unitPricePaise: product.pricePaise,
          gstRateBps: product.gstRateBps,
          requestedQuantity: 0,
          quantity,
          addedByAdmin: true,
        },
      });
    }
    await recordEvent(tx, {
      ...actor(ctx),
      orderId,
      type: 'ITEM_ADDED',
      message: `Added ${product.name} × ${quantity}`,
      data: { productId: product.id, sku: product.sku, quantity },
    });
    await afterItemsChanged(tx, orderId, ctx);
  });
}

export function replaceItem(orderId: string, itemId: string, productId: string, quantity: number | undefined, ctx: AdminContext) {
  return withTx(prisma, async (tx) => {
    const order = await lockForEdit(tx, orderId, ctx, EDITABLE_STATUSES);
    const item = await findItem(tx, orderId, itemId);
    if (item.removed) throw new ValidationError('This item was already removed');
    const product = await findActiveProduct(tx, productId);
    if (product.id === item.productId) throw new ValidationError('Choose a different product to replace with');
    if (order.items.some((i) => i.productId === product.id && !i.removed)) {
      throw new ValidationError(`${product.name} is already in this order`);
    }
    const newQuantity = quantity ?? item.quantity;
    assertQuantity(newQuantity);

    await tx.orderItem.update({ where: { id: itemId }, data: { removed: true, quantity: 0 } });
    await tx.orderItem.create({
      data: {
        orderId,
        productId: product.id,
        sku: product.sku,
        retailerId: product.retailerId,
        name: product.name,
        unitPricePaise: product.pricePaise,
        gstRateBps: product.gstRateBps,
        requestedQuantity: 0,
        quantity: newQuantity,
        addedByAdmin: true,
        replacesItemId: item.id,
      },
    });
    await recordEvent(tx, {
      ...actor(ctx),
      orderId,
      type: 'ITEM_REPLACED',
      message: `Replaced ${item.name} × ${item.quantity} with ${product.name} × ${newQuantity}`,
      data: { fromItemId: item.id, fromSku: item.sku, toSku: product.sku, quantity: newQuantity },
    });
    await afterItemsChanged(tx, orderId, ctx);
  });
}

export function setDiscount(orderId: string, discountPaise: number, reason: string | undefined, ctx: AdminContext) {
  if (!Number.isInteger(discountPaise) || discountPaise < 0) {
    throw new ValidationError('Discount must be a non-negative amount');
  }
  return withTx(prisma, async (tx) => {
    const order = await lockForEdit(tx, orderId, ctx, DISCOUNT_STATUSES);
    if (discountPaise > order.subtotalPaise) {
      throw new ValidationError('Discount cannot be more than the product subtotal');
    }
    if (order.discountPaise === discountPaise && (order.discountReason ?? undefined) === reason) return;

    await tx.order.update({ where: { id: orderId }, data: { discountPaise, discountReason: reason ?? null } });
    await recordEvent(tx, {
      ...actor(ctx),
      orderId,
      type: 'DISCOUNT_CHANGED',
      message: `Discount ${formatINR(order.discountPaise)} → ${formatINR(discountPaise)}${reason ? ` (${reason})` : ''}`,
      data: { from: order.discountPaise, to: discountPaise, reason: reason ?? null },
    });
    await recalculateTotals(tx, orderId, actor(ctx));
    // The discount changes the goods value, which can cross the free-shipping threshold.
    await reapplyShippingRules(tx, orderId, actor(ctx));
    // The customer may be looking at a revised order that shows the old discount: withdraw it,
    // like an item edit does, so they only ever accept what they were shown.
    if (order.status === 'AWAITING_CUSTOMER_APPROVAL') {
      await cancelJobs(tx, orderId, ['approval.reminder', 'approval.timeout']);
      await transitionOrder(orderId, 'MODIFIED', { ...actor(ctx), reason: 'Discount changed – send the revised order again' }, tx);
    }
  });
}

export async function addNote(orderId: string, note: string, adminId: string) {
  const text = note.trim();
  if (!text) throw new ValidationError('Note is empty');
  if (text.length > 2000) throw new ValidationError('Note is too long (max 2000 characters)');
  await getOrder(prisma, orderId);
  await recordEvent(prisma, { actor: 'ADMIN', actorRef: adminId, orderId, type: 'NOTE', message: text });
}

// ─────────────────────────────────────────────────────────────
// Review actions
// ─────────────────────────────────────────────────────────────

export type AdminAction =
  | 'start_review'
  | 'approve'
  | 'resend'
  | 'quote_shipping'
  | 'request_payment'
  | 'withdraw_payment'
  | 'create_shipment'
  | 'retry_refund'
  | 'refresh_tracking'
  | 'mark_delivered'
  | 'close_undelivered'
  | 'cancel';

export interface ActionInfo {
  id: AdminAction;
  label: string;
  tone: 'primary' | 'danger' | 'neutral';
}

export function availableActions(
  order: Order & { items: OrderItem[] },
  extra: { shipmentIncomplete: boolean; shipmentJobQueued: boolean; hasAwb: boolean; refundDue: boolean } = {
    shipmentIncomplete: false,
    shipmentJobQueued: false,
    hasAwb: false,
    refundDue: false,
  },
): ActionInfo[] {
  const actions: ActionInfo[] = [];
  const modified = isModifiedFromRequest(order.items);

  // (Opening a NEW order moves it to review automatically, so there is no separate button.)
  if (order.status === 'NEW' || order.status === 'PENDING_REVIEW') {
    actions.push({ id: 'approve', label: 'Approve order', tone: 'primary' });
  }
  if (order.status === 'MODIFIED' && modified) {
    actions.push({ id: 'approve', label: 'Send revised order to customer', tone: 'primary' });
  }
  if (order.status === 'READY_FOR_PAYMENT') {
    actions.push({ id: 'request_payment', label: 'Send payment request', tone: 'primary' });
  }
  if (order.status === 'PAYMENT_REQUESTED') {
    actions.push({ id: 'withdraw_payment', label: 'Withdraw payment request', tone: 'neutral' });
  }
  if ((order.status === 'PAID' || order.status === 'PROCESSING') && extra.shipmentIncomplete && !extra.shipmentJobQueued) {
    actions.push({ id: 'create_shipment', label: 'Retry shipment', tone: 'primary' });
  }
  if (extra.refundDue) {
    actions.push({ id: 'retry_refund', label: 'Retry refund', tone: 'primary' });
  }
  if (extra.hasAwb && ['PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(order.status)) {
    actions.push({ id: 'refresh_tracking', label: 'Refresh tracking', tone: 'neutral' });
  }
  if (['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(order.status)) {
    actions.push({ id: 'mark_delivered', label: 'Mark as delivered', tone: 'neutral' });
  }
  if (
    order.status === 'AWAITING_CUSTOMER_APPROVAL' ||
    order.status === 'PAYMENT_REQUESTED' ||
    (order.status === 'AWAITING_ADDRESS' && !order.shipPincode)
  ) {
    actions.push({ id: 'resend', label: 'Resend WhatsApp message', tone: 'neutral' });
  }
  // Normally automatic once the address arrives; offered when that failed (e.g. Shiprocket was down).
  if (order.status === 'AWAITING_ADDRESS' && order.shipPincode && !order.shippingQuotedAt) {
    actions.push({ id: 'quote_shipping', label: 'Calculate shipping', tone: 'primary' });
  }
  if (!isPaid(order.status) && order.status !== 'CANCELLED') {
    actions.push({ id: 'cancel', label: 'Cancel order', tone: 'danger' });
  }
  if ((REFUNDABLE_STATUSES as readonly string[]).includes(order.status)) {
    actions.push({ id: 'cancel', label: 'Cancel & refund', tone: 'danger' });
  }
  if ((CLOSABLE_AFTER_DISPATCH as readonly string[]).includes(order.status)) {
    actions.push({ id: 'close_undelivered', label: 'Close – not delivered', tone: 'danger' });
  }
  return actions;
}

function assertVersion(order: Order, expectedVersion: number) {
  if (order.version !== expectedVersion) throw new ConflictError('Order was updated by someone else – reload and try again');
}

export async function runAction(
  orderId: string,
  action: AdminAction,
  ctx: AdminContext & { reason?: string },
): Promise<{ order: Order; warning?: string }> {
  const opts = { ...actor(ctx), expectedVersion: ctx.expectedVersion, reason: ctx.reason };

  switch (action) {
    case 'start_review':
      return { order: await transitionOrder(orderId, 'PENDING_REVIEW', opts) };

    case 'resend': {
      assertVersion(await getOrder(prisma, orderId), ctx.expectedVersion);
      await resendCurrentRequest(orderId);
      return { order: await getOrder(prisma, orderId) };
    }

    case 'request_payment':
      return requestPayment(orderId, { ...actor(ctx), expectedVersion: ctx.expectedVersion });

    case 'withdraw_payment':
      return withdrawPaymentRequest(orderId, { ...actor(ctx), expectedVersion: ctx.expectedVersion });

    case 'create_shipment': {
      // Never alongside the background job, and never twice at once: claim the order version first.
      const queued = await prisma.scheduledJob.count({ where: { orderId, type: 'shipment.create', status: { in: ['PENDING', 'RUNNING'] } } });
      if (queued > 0) throw new ConflictError('The shipment is already being created – wait a moment and reload');
      const { count } = await prisma.order.updateMany({
        where: { id: orderId, version: ctx.expectedVersion, status: { in: ['PAID', 'PROCESSING'] } },
        data: { version: { increment: 1 } },
      });
      if (count === 0) throw new ConflictError('Order was updated by someone else – reload and try again');
      try {
        await createShipment(orderId);
        return { order: await getOrder(prisma, orderId) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordEvent(prisma, { ...actor(ctx), orderId, type: 'ERROR', message: `Shipment retry failed: ${message}`.slice(0, 500) });
        return { order: await getOrder(prisma, orderId), warning: `Shipment could not be created: ${message}` };
      }
    }

    case 'retry_refund': {
      assertVersion(await getOrder(prisma, orderId), ctx.expectedVersion);
      const result = await retryRefunds(orderId, ctx.adminId);
      return { order: await getOrder(prisma, orderId), warning: result.warning };
    }

    case 'refresh_tracking': {
      await refreshTracking(orderId, actor(ctx));
      return { order: await getOrder(prisma, orderId) };
    }

    case 'mark_delivered': {
      assertVersion(await getOrder(prisma, orderId), ctx.expectedVersion);
      await markDelivered(orderId, ctx.adminId);
      return { order: await getOrder(prisma, orderId) };
    }

    case 'quote_shipping': {
      const result = await quoteShipping(orderId, { ...actor(ctx), expectedVersion: ctx.expectedVersion });
      return { order: await getOrder(prisma, orderId), warning: result.ok ? undefined : result.message };
    }

    case 'approve': {
      const approved = await withTx(prisma, async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: { include: { product: true } } },
        });
        if (!order) throw new NotFoundError('Order', orderId);

        const problems = stockProblems(order.items);
        if (problems.length > 0) {
          throw new ConflictError(
            `Fix stock before approving: ${problems.map(describeStockProblem).join('; ')}`,
            { problems },
          );
        }
        // Unchanged orders go straight to address collection; changed ones need the customer's OK first.
        const target: OrderStatus = isModifiedFromRequest(order.items) ? 'AWAITING_CUSTOMER_APPROVAL' : 'AWAITING_ADDRESS';
        const moved = await transitionOrder(orderId, target, { ...opts, reason: undefined }, tx);
        if (target === 'AWAITING_CUSTOMER_APPROVAL') {
          // A new approval round in the same transaction: buttons from earlier versions can never
          // match this one, not even in the moment before the new message goes out.
          return tx.order.update({ where: { id: orderId }, data: { approvalRound: { increment: 1 } } });
        }
        return moved;
      });
      // WhatsApp is called after the commit; a failed send leaves the approval in place.
      return { order: approved, warning: await afterAdminApproval(orderId) };
    }

    case 'cancel': {
      const reason = ctx.reason?.trim();
      if (!reason) throw new ValidationError('Please give a reason for cancelling');
      const order = await getOrder(prisma, orderId);
      if ((REFUNDABLE_STATUSES as readonly string[]).includes(order.status)) {
        const result = await cancelPaidOrder(orderId, ctx.adminId, ctx.expectedVersion, reason);
        return { order: await getOrder(prisma, orderId), warning: result.warning };
      }
      if ((CLOSABLE_AFTER_DISPATCH as readonly string[]).includes(order.status)) {
        throw new ConflictError('The parcel has been dispatched – use “Close – not delivered” if it will not reach the customer');
      }
      if (isPaid(order.status) || order.status === 'CANCELLED') throw new ConflictError('This order can no longer be cancelled');
      return cancelOrder(orderId, opts, reason, 'store');
    }

    case 'close_undelivered':
      throw new ValidationError('Use the close endpoint, which asks whether to return stock and refund');
  }
}

// ─────────────────────────────────────────────────────────────
// Queries for the dashboard
// ─────────────────────────────────────────────────────────────

export interface OrderListQuery {
  statuses?: OrderStatus[];
  search?: string;
  stockIssuesOnly?: boolean;
  page: number;
  pageSize: number;
}

async function ordersWithStockIssues(): Promise<Set<string>> {
  const open = await prisma.order.findMany({
    where: { status: { in: [...OPEN_REVIEW_STATUSES] } },
    select: { id: true, items: { include: { product: true } } },
  });
  return new Set(open.filter((o) => stockProblems(o.items).length > 0).map((o) => o.id));
}

export async function listOrders(query: OrderListQuery) {
  const where: Prisma.OrderWhereInput = {};
  if (query.statuses?.length) where.status = { in: query.statuses };

  const search = query.search?.trim();
  if (search) {
    where.OR = [
      { requestNumber: { contains: search.toUpperCase() } },
      { orderNumber: { contains: search.toUpperCase() } },
      { customer: { waId: { contains: search.replace(/\D/g, '') || search } } },
      { customer: { name: containsText(search) } },
      { shipName: containsText(search) },
    ];
  }

  const stockIssueIds = await ordersWithStockIssues();
  if (query.stockIssuesOnly) where.id = { in: [...stockIssueIds] };

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // stable paging when requests arrive together
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { customer: true, items: { include: { product: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    }),
  ]);

  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    orders: orders.map((o) => {
      const items = o.items.filter((item) => !item.removed && item.quantity > 0);
      return {
        id: o.id,
        requestNumber: o.requestNumber,
        orderNumber: o.orderNumber,
        status: o.status,
        version: o.version,
        customer: { name: o.customer.name, waId: o.customer.waId },
        itemsSummary: items.map((i) => `${i.name} × ${i.quantity}`).join(', '),
        itemImages: items.slice(0, 3).map((i) => ({ name: i.name, imageUrl: i.product?.imageUrl ?? null })),
        itemCount: items.reduce((n, i) => n + i.quantity, 0),
        totalPaise: o.totalPaise,
        modified: isModifiedFromRequest(o.items),
        stockIssue: stockIssueIds.has(o.id),
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      };
    }),
  };
}

export async function orderSummary() {
  const [groups, stockIssues] = await Promise.all([
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    ordersWithStockIssues(),
  ]);
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Partial<Record<OrderStatus, number>>;
  return { counts, stockIssues: stockIssues.size };
}

export async function orderDetail(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      // Rows written in the same instant tie on createdAt; ids (time-ordered) break the tie.
      items: { include: { product: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      payments: { orderBy: { createdAt: 'desc' } },
      shipments: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!order) throw new NotFoundError('Order', orderId);

  const adminIds = [...new Set(order.events.filter((e) => e.actor === 'ADMIN' && e.actorRef).map((e) => e.actorRef!))];
  const admins = await prisma.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } });
  const adminNames = new Map(admins.map((a) => [a.id, a.name]));

  // Stock only matters until the order is approved. After payment the order's own units are
  // already deducted, so comparing again would count them twice.
  const problems = OPEN_REVIEW_STATUSES.includes(order.status) ? stockProblems(order.items) : [];
  const editableItems = EDITABLE_STATUSES.includes(order.status);

  return {
    ...order,
    rawRequest: undefined,
    items: order.items.map((i) => ({
      ...i,
      product: undefined,
      imageUrl: i.product?.imageUrl ?? null,
      availableStock: i.product?.stock ?? null,
      productActive: i.product?.active ?? false,
      stockIssue: problems.some((p) => p.itemId === i.id),
    })),
    events: order.events.map((e) => ({
      ...e,
      actorName: e.actor === 'ADMIN' && e.actorRef ? (adminNames.get(e.actorRef) ?? 'Admin') : null,
    })),
    modified: isModifiedFromRequest(order.items),
    stockProblems: problems.map((p) => ({ ...p, message: describeStockProblem(p) })),
    permissions: {
      editItems: editableItems,
      editDiscount: DISCOUNT_STATUSES.includes(order.status),
      editAddress: order.status === 'AWAITING_ADDRESS' || order.status === 'READY_FOR_PAYMENT',
      editShipping: order.status === 'READY_FOR_PAYMENT' || (order.status === 'AWAITING_ADDRESS' && !!order.shipPincode),
    },
    actions: availableActions(order, {
      shipmentIncomplete: (order.status === 'PAID' || order.status === 'PROCESSING') && (await shipmentIncomplete(order.id)),
      shipmentJobQueued: (await prisma.scheduledJob.count({ where: { orderId: order.id, type: 'shipment.create', status: { in: ['PENDING', 'RUNNING'] } } })) > 0,
      hasAwb: order.shipments.some((sh) => sh.awb && sh.currentStatus !== 'CANCELLED'),
      refundDue: (await pendingRefunds(order.id)).length > 0,
    }),
    testMode: allMocked,
  };
}
