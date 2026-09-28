import type { Order, OrderStatus } from '@prisma/client';
import { env } from '../config/env.js';
import { buildPackage, chooseCourier, customerShippingCharge, type PackageSize, type ShippingRules } from '../domain/shipping.js';
import { integrations } from '../integrations/index.js';
import type { CourierOption } from '../integrations/shiprocket/types.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { formatINR, rupeesToPaise } from '../lib/money.js';
import { prisma, type Tx } from '../lib/prisma.js';
import { recordEvent, type ActorContext } from './audit.js';
import { activeItems, getOrder, recalculateTotals, transitionOrder, withTx } from './orders.js';

/** Statuses in which shipping can be (re)calculated or overridden. */
const QUOTABLE: readonly OrderStatus[] = ['AWAITING_ADDRESS', 'READY_FOR_PAYMENT'];

/** Prefix marking a shipping charge set by hand – such charges are never recalculated automatically. */
export const MANUAL_SHIPPING_PREFIX = 'Set by admin';

export function shippingRules(): ShippingRules {
  return {
    freeAbovePaise: rupeesToPaise(env.FREE_SHIPPING_ABOVE_RUPEES),
    flatRatePaise: env.SHIPPING_FLAT_RATE_RUPEES !== undefined ? rupeesToPaise(env.SHIPPING_FLAT_RATE_RUPEES) : undefined,
    roundToRupee: env.SHIPPING_ROUND_TO_RUPEE,
  };
}

/** Parcel size for the order, from each product's packed weight and box size. */
export async function orderPackage(orderId: string, db: Tx | typeof prisma = prisma): Promise<PackageSize> {
  const items = await db.orderItem.findMany({ where: { orderId }, include: { product: true } });
  const active = activeItems(items) as typeof items;
  if (active.length === 0) throw new ValidationError('Order has no items to ship');
  return buildPackage(
    active.map((i) => ({
      quantity: i.quantity,
      // Unknown products fall back to a small jewellery box
      weightGrams: i.product?.weightGrams ?? 100,
      lengthCm: i.product?.lengthCm ?? 10,
      breadthCm: i.product?.breadthCm ?? 10,
      heightCm: i.product?.heightCm ?? 5,
    })),
    env.PACKAGING_WEIGHT_GRAMS,
  );
}

function assertQuotable(order: Order) {
  if (!QUOTABLE.includes(order.status)) throw new ConflictError('Shipping can only be changed before payment is requested');
  if (!order.shipPincode) throw new ConflictError('The delivery address is needed before shipping can be calculated');
}

export interface ShippingOptions {
  package: PackageSize;
  options: (CourierOption & { customerChargePaise: number })[];
  suggestedCourierId: number | null;
}

/** Live courier options for the order's delivery pincode (for the admin's courier picker). */
export async function shippingOptions(orderId: string): Promise<ShippingOptions> {
  const order = await getOrder(prisma, orderId);
  assertQuotable(order);
  const pkg = await orderPackage(orderId);
  const options = await fetchRates(order, pkg);
  const rules = shippingRules();
  const goods = order.subtotalPaise - order.discountPaise;
  return {
    package: pkg,
    options: options
      .map((o) => ({ ...o, customerChargePaise: customerShippingCharge(o.ratePaise, goods, rules).chargePaise }))
      .sort((a, b) => a.ratePaise - b.ratePaise),
    suggestedCourierId: chooseCourier(options, env.SHIPPING_COURIER_STRATEGY)?.courierId ?? null,
  };
}

function fetchRates(order: Order, pkg: PackageSize) {
  return integrations().shiprocket.getRates({
    pickupPincode: env.SHIPROCKET_PICKUP_PINCODE,
    deliveryPincode: order.shipPincode!,
    weightKg: pkg.weightGrams / 1000,
    lengthCm: pkg.lengthCm,
    breadthCm: pkg.breadthCm,
    heightCm: pkg.heightCm,
    declaredValuePaise: order.subtotalPaise - order.discountPaise,
    cod: false,
  });
}

export type QuoteResult =
  | { ok: true; courier: CourierOption; chargePaise: number }
  | { ok: false; reason: 'unserviceable' | 'error'; message: string };

/** The state a quote was calculated for – it is only saved if the order is still exactly like this. */
interface QuoteGuard {
  version: number;
  pincode: string | null;
}

export class StaleQuoteError extends ConflictError {
  constructor() {
    super('The order changed while shipping was being calculated – reload and try again');
  }
}

/**
 * Gets live Shiprocket rates, picks a courier (strategy or the admin's choice), applies the
 * shipping rules and stores the result. An order waiting for its quote moves to READY_FOR_PAYMENT,
 * where the admin checks the final amount before payment is requested.
 */
export async function quoteShipping(orderId: string, ctx: ActorContext & { expectedVersion?: number }, courierId?: number): Promise<QuoteResult> {
  const order = await getOrder(prisma, orderId);
  assertQuotable(order);
  if (ctx.expectedVersion !== undefined && ctx.expectedVersion !== order.version) {
    throw new ConflictError('Order was updated by someone else – reload and try again');
  }
  const pkg = await orderPackage(orderId);

  let options: CourierOption[];
  try {
    options = await fetchRates(order, pkg);
  } catch (err) {
    const message = `Shipping could not be calculated: ${err instanceof Error ? err.message : err}`;
    logger.error({ err, orderId }, 'Shiprocket rate lookup failed');
    await recordEvent(prisma, { actor: 'SYSTEM', orderId, type: 'ERROR', message: message.slice(0, 500) });
    return { ok: false, reason: 'error', message };
  }

  if (options.length === 0) {
    const message = `No courier delivers to pincode ${order.shipPincode}`;
    await recordEvent(prisma, { actor: 'SYSTEM', orderId, type: 'ERROR', message, data: { pincode: order.shipPincode } });
    return { ok: false, reason: 'unserviceable', message };
  }

  const courier = courierId ? options.find((o) => o.courierId === courierId) : chooseCourier(options, env.SHIPPING_COURIER_STRATEGY);
  if (!courier) throw new ValidationError('That courier is no longer available for this address – pick another');

  // A charge the admin set by hand survives automatic re-quotes (e.g. the customer re-sends
  // their address); only the admin replaces it, by picking a courier or setting a new charge.
  const keepManual = ctx.actor !== 'ADMIN' && !!order.shippingNote?.startsWith(MANUAL_SHIPPING_PREFIX);
  const { chargePaise, note } = keepManual
    ? { chargePaise: order.shippingPaise, note: order.shippingNote }
    : customerShippingCharge(courier.ratePaise, order.subtotalPaise - order.discountPaise, shippingRules());
  await applyShipping(
    orderId,
    ctx,
    {
      chargePaise,
      costPaise: courier.ratePaise,
      courier,
      note,
      weightGrams: pkg.weightGrams,
      detail: `${courier.courierName}${courier.etdDays ? `, ${courier.etdDays} days` : ''}: customer pays ${formatINR(chargePaise)} (courier cost ${formatINR(courier.ratePaise)})${keepManual ? ' – shipping charge set by admin kept' : note ? ` – ${note}` : ''}`,
      options,
    },
    { version: order.version, pincode: order.shipPincode },
  );
  return { ok: true, courier, chargePaise };
}

/** Admin sets the customer's shipping charge by hand (e.g. free shipping for a loyal customer). */
export async function setManualShipping(orderId: string, chargePaise: number, reason: string, adminId: string, expectedVersion: number) {
  if (!Number.isInteger(chargePaise) || chargePaise < 0) throw new ValidationError('Shipping must be a non-negative amount');
  const text = reason.trim();
  if (!text) throw new ValidationError('Please give a reason for changing the shipping charge');

  const order = await getOrder(prisma, orderId);
  assertQuotable(order);
  if (order.version !== expectedVersion) throw new ConflictError('Order was updated by someone else – reload and try again');

  await applyShipping(
    orderId,
    { actor: 'ADMIN', actorRef: adminId },
    {
      chargePaise,
      costPaise: order.shippingCostPaise,
      note: `${MANUAL_SHIPPING_PREFIX}: ${text}`,
      weightGrams: order.packageWeightGrams ?? (await orderPackage(orderId)).weightGrams,
      detail: `Shipping charge set to ${formatINR(chargePaise)} by admin – ${text}`,
    },
    { version: order.version, pincode: order.shipPincode },
  );
}

async function applyShipping(
  orderId: string,
  ctx: ActorContext,
  s: {
    chargePaise: number;
    costPaise: number | null;
    courier?: CourierOption;
    note: string | null;
    weightGrams: number;
    detail: string;
    options?: CourierOption[];
  },
  guard: QuoteGuard,
) {
  await withTx(prisma, async (tx) => {
    const order = await getOrder(tx, orderId);
    // The rate lookup takes time. Only save if nothing changed meanwhile – a newer address, a
    // payment request or another admin's edit must not be overwritten by this older quote.
    const { count } = await tx.order.updateMany({
      where: { id: orderId, version: guard.version, status: { in: [...QUOTABLE] }, shipPincode: guard.pincode },
      data: {
        shippingPaise: s.chargePaise,
        shippingCostPaise: s.costPaise,
        shippingNote: s.note,
        packageWeightGrams: s.weightGrams,
        shippingQuotedAt: new Date(),
        ...(s.courier
          ? { shippingCourierId: s.courier.courierId, shippingCourierName: s.courier.courierName, shippingEtdDays: s.courier.etdDays }
          : {}),
        version: { increment: 1 },
      },
    });
    if (count === 0) throw new StaleQuoteError();
    await recordEvent(tx, {
      ...ctx,
      orderId,
      type: 'SHIPPING_QUOTED',
      message: s.detail.slice(0, 500),
      data: {
        chargePaise: s.chargePaise,
        costPaise: s.costPaise,
        courierId: s.courier?.courierId ?? null,
        weightGrams: s.weightGrams,
        options: (s.options ?? []).map((o) => ({ id: o.courierId, name: o.courierName, ratePaise: o.ratePaise, etdDays: o.etdDays })),
      },
    });
    await recalculateTotals(tx, orderId, ctx);
    if (order.status === 'AWAITING_ADDRESS') {
      // Only the actor is passed on: the caller's expectedVersion was checked before this
      // transaction and is stale by now (the updates above bumped the version).
      // Customers never move this step themselves – the system does it on their behalf.
      const by: ActorContext =
        ctx.actor === 'ADMIN' ? { actor: 'ADMIN', actorRef: ctx.actorRef } : { actor: 'SYSTEM', actorRef: 'shipping' };
      await transitionOrder(orderId, 'READY_FOR_PAYMENT', { ...by, reason: 'Shipping calculated – final amount ready for review' }, tx);
    }
  });
}

/**
 * Re-applies the shipping rules after the goods value changes (e.g. a discount pushes the
 * order below the free-shipping threshold). Manual charges are left alone.
 */
export async function reapplyShippingRules(tx: Tx, orderId: string, ctx: ActorContext): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order', orderId);
  if (!order.shippingQuotedAt || order.shippingCostPaise === null || order.shippingNote?.startsWith(MANUAL_SHIPPING_PREFIX)) return;

  const { chargePaise, note } = customerShippingCharge(order.shippingCostPaise, order.subtotalPaise - order.discountPaise, shippingRules());
  if (chargePaise === order.shippingPaise && note === order.shippingNote) return;

  await tx.order.update({ where: { id: orderId }, data: { shippingPaise: chargePaise, shippingNote: note } });
  await recordEvent(tx, {
    ...ctx,
    orderId,
    type: 'SHIPPING_QUOTED',
    message: `Shipping for the customer ${formatINR(order.shippingPaise)} → ${formatINR(chargePaise)}${note ? ` – ${note}` : ''}`,
  });
  await recalculateTotals(tx, orderId, ctx);
}
