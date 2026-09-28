import type { Shipment } from '@prisma/client';
import { env } from '../config/env.js';
import { integrations } from '../integrations/index.js';
import { ShiprocketApiError } from '../integrations/shiprocket/live.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { recordEvent } from './audit.js';
import { registerJobHandler } from './jobs.js';
import { activeItems, getOrder, transitionOrder, withTx } from './orders.js';
import { orderPackage } from './shipping.js';

/**
 * Creates the Shiprocket shipment for a paid order: Shiprocket order → AWB (courier) → pickup →
 * manifest. Each step is stored as it completes, so a retry continues where the last attempt
 * stopped and never creates a second Shiprocket order. Only one run per order at a time (the
 * shipment row is marked CREATING), and the order is re-checked before every step so a
 * cancellation stops it.
 */

/** A CREATING mark older than this is treated as abandoned (the process died mid-way). */
const CREATING_STALE_MS = 10 * 60 * 1000;

class OrderCancelledError extends Error {}

async function assertStillShippable(orderId: string) {
  const order = await getOrder(prisma, orderId);
  if (order.status !== 'PAID' && order.status !== 'PROCESSING') throw new OrderCancelledError(order.status);
  return order;
}

export async function createShipment(orderId: string): Promise<Shipment | null> {
  const first = await prisma.order.findUnique({ where: { id: orderId } });
  if (!first) throw new NotFoundError('Order', orderId);
  if (first.status === 'CANCELLED') return null;
  if (first.status !== 'PAID' && first.status !== 'PROCESSING') {
    throw new ConflictError(`Shipments are created for paid orders (this one is ${first.status})`);
  }

  // Claim: one run per order at a time. Finding-or-creating the shipment row and marking it
  // CREATING happen under a lock on the order row, so two overlapping runs cannot each create
  // (and claim) a shipment of their own.
  const claimed = await withTx(prisma, async (tx) => {
    await tx.order.updateMany({ where: { id: orderId }, data: { updatedAt: new Date() } });
    const row =
      (await tx.shipment.findFirst({ where: { orderId, currentStatus: { not: 'CANCELLED' } }, orderBy: { createdAt: 'asc' } })) ??
      (await tx.shipment.create({ data: { orderId } }));
    const { count } = await tx.shipment.updateMany({
      where: {
        id: row.id,
        OR: [{ currentStatus: null }, { currentStatus: { not: 'CREATING' } }, { updatedAt: { lt: new Date(Date.now() - CREATING_STALE_MS) } }],
      },
      data: { currentStatus: 'CREATING' },
    });
    return count === 0 ? null : row;
  });
  if (!claimed) throw new ConflictError('The shipment is already being created – try again in a minute');
  let shipment = claimed;
  const previousStatus = shipment.currentStatus;

  const { shiprocket } = integrations();
  const note = (message: string, data?: object) =>
    recordEvent(prisma, { actor: 'SYSTEM', actorRef: 'fulfilment', orderId, type: 'SHIPMENT_EVENT', message, data: data as never });
  let finalStatus = previousStatus === 'CREATING' ? null : previousStatus;

  try {
    // 1. Shiprocket order
    if (!shipment.shiprocketOrderId) {
      const order = await assertStillShippable(orderId);
      const items = await prisma.orderItem.findMany({ where: { orderId }, include: { product: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const pkg = await orderPackage(orderId);
      const created = await shiprocket.createOrder({
        orderNumber: order.orderNumber!,
        orderDate: order.paidAt ?? new Date(),
        pickupLocation: env.SHIPROCKET_PICKUP_LOCATION,
        customer: {
          name: order.shipName!,
          phone: order.shipPhone!,
          address: [order.shipHouse, order.shipStreet].filter(Boolean).join(', '),
          address2: order.shipLandmark ?? undefined,
          city: order.shipCity!,
          state: order.shipState!,
          pincode: order.shipPincode!,
        },
        items: (activeItems(items) as typeof items).map((i) => ({
          name: i.name,
          sku: i.sku,
          units: i.quantity,
          sellingPricePaise: i.unitPricePaise,
          hsn: i.product?.hsnCode ?? undefined,
          taxRateBps: i.gstRateBps,
        })),
        paymentMethod: 'Prepaid',
        subTotalPaise: order.subtotalPaise,
        shippingPaise: order.shippingPaise,
        discountPaise: order.discountPaise,
        weightKg: pkg.weightGrams / 1000,
        lengthCm: pkg.lengthCm,
        breadthCm: pkg.breadthCm,
        heightCm: pkg.heightCm,
      });
      shipment = await prisma.shipment.update({
        where: { id: shipment.id },
        data: { shiprocketOrderId: created.shiprocketOrderId, shiprocketShipmentId: created.shipmentId },
      });
      finalStatus = 'NEW';
      await note(`Shiprocket order ${created.shiprocketOrderId} created (shipment ${created.shipmentId})`);
    }

    // 2. AWB – the courier chosen at quote time; Shiprocket's pick only if that courier refuses it.
    if (!shipment.awb) {
      const order = await assertStillShippable(orderId);
      let awb;
      try {
        awb = await shiprocket.assignAwb(shipment.shiprocketShipmentId!, order.shippingCourierId ?? undefined);
      } catch (err) {
        // Only a definite refusal (4xx) of the chosen courier falls back; outages and network errors
        // are retried later with the same courier.
        const refused = err instanceof ShiprocketApiError && !err.retryable;
        if (!order.shippingCourierId || !refused) throw err;
        logger.warn({ err, orderId }, 'chosen courier refused the shipment, letting Shiprocket assign one');
        await note(`${order.shippingCourierName ?? 'Chosen courier'} could not take the shipment (${err.message}) – letting Shiprocket assign a courier`);
        awb = await shiprocket.assignAwb(shipment.shiprocketShipmentId!);
      }
      shipment = await prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          awb: awb.awb,
          courierId: awb.courierId,
          courierName: awb.courierName,
          trackingUrl: `https://shiprocket.co/tracking/${awb.awb}`,
          // lastEventAt is left for courier events only – it decides which tracking update is newest,
          // and our own clock must not make a genuine courier scan look out of date.
        },
      });
      finalStatus = 'AWB ASSIGNED';
      await note(`AWB ${awb.awb} assigned (${awb.courierName})`, { awb: awb.awb, courierId: awb.courierId });
    }

    // 3. PAID → PROCESSING (outside the AWB step, so a crash right after the AWB is still recovered)
    const now = await getOrder(prisma, orderId);
    if (now.status === 'PAID') {
      await transitionOrder(orderId, 'PROCESSING', { actor: 'SYSTEM', actorRef: 'fulfilment', reason: `Shipment ready – AWB ${shipment.awb}` });
    }

    // 4. Pickup
    if (!shipment.pickupRequestedAt) {
      await assertStillShippable(orderId);
      await shiprocket.requestPickup(shipment.shiprocketShipmentId!);
      shipment = await prisma.shipment.update({ where: { id: shipment.id }, data: { pickupRequestedAt: new Date() } });
      finalStatus = 'PICKUP SCHEDULED';
      await note('Pickup requested');

      // 5. Manifest (Shiprocket asks for it after pickup). Not blocking: it can also be generated in Shiprocket.
      try {
        await shiprocket.generateManifest(shipment.shiprocketShipmentId!);
      } catch (err) {
        await note(`Manifest could not be generated automatically (${err instanceof Error ? err.message : err}) – generate it in Shiprocket`);
      }
    }
    return releaseClaim(shipment.id, finalStatus);
  } catch (err) {
    if (err instanceof OrderCancelledError) {
      // Cancelled while we were working: undo what was created at Shiprocket.
      if (shipment.shiprocketOrderId) {
        await shiprocket.cancelOrder(shipment.shiprocketOrderId).catch((e) =>
          recordEvent(prisma, {
            actor: 'SYSTEM',
            orderId,
            type: 'ERROR',
            message: `Order was cancelled, but Shiprocket order ${shipment.shiprocketOrderId} could not be cancelled automatically (${e instanceof Error ? e.message : e}) – cancel it in Shiprocket.`,
          }),
        );
      }
      await prisma.shipment.update({ where: { id: shipment.id }, data: { currentStatus: 'CANCELLED' } });
      return null;
    }
    // Release the claim so a retry can continue.
    await releaseClaim(shipment.id, finalStatus);
    throw err;
  }
}

/** Ends the CREATING claim – unless a courier update has set a real status meanwhile, which is kept. */
async function releaseClaim(shipmentId: string, status: string | null): Promise<Shipment> {
  await prisma.shipment.updateMany({ where: { id: shipmentId, currentStatus: 'CREATING' }, data: { currentStatus: status } });
  return prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
}

/** Whether the shipment still has steps left (shown as "Retry shipment" to the admin). */
export async function shipmentIncomplete(orderId: string): Promise<boolean> {
  const shipment = await prisma.shipment.findFirst({ where: { orderId, currentStatus: { not: 'CANCELLED' } } });
  return !shipment?.pickupRequestedAt;
}

registerJobHandler('shipment.create', async (job) => {
  try {
    await createShipment(job.orderId!);
  } catch (err) {
    const attempt = job.attempts + 1;
    await recordEvent(prisma, {
      actor: 'SYSTEM',
      actorRef: 'fulfilment',
      orderId: job.orderId!,
      type: 'ERROR',
      message: `Shipment step failed (attempt ${attempt} of 3): ${err instanceof Error ? err.message : err}`.slice(0, 500),
    });
    throw err;
  }
});
