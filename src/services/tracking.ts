import type { OrderStatus, Prisma, Shipment } from '@prisma/client';
import { env } from '../config/env.js';
import { classifyShiprocketStatus, pathTo } from '../domain/tracking.js';
import { integrations } from '../integrations/index.js';
import type { TemplateMessage } from '../integrations/whatsapp/types.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import * as copy from '../messages/copy.js';
import { recordEvent, type ActorContext } from './audit.js';
import { registerJobHandler, scheduleJob } from './jobs.js';
import { sendWithFallback, templateComponents, type OutboundMessage } from './messaging.js';
import { getOrder, transitionOrder, withTx } from './orders.js';
import { getSettings, instagramUrl, type Milestone } from './settings.js';

/**
 * Shipment tracking: status updates from the Shiprocket webhook, the poll, or an admin move the
 * order along SHIPPED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED, notify the customer at the
 * milestones the team has switched on, and schedule the feedback message after delivery.
 *
 * Updates for one shipment are handled one at a time (the shipment row is written first inside the
 * transaction, which locks it). `lastEventAt` only ever holds courier time – never our own clock –
 * because it decides which update is the newest.
 */

export interface TrackingUpdate {
  awb?: string;
  orderNumber?: string;
  /** Courier status label, e.g. "OUT FOR DELIVERY" */
  status: string;
  /** Courier's time of the event; null/undefined when the courier did not say */
  at?: Date | null;
  location?: string | null;
  raw?: unknown;
  /**
   * webhook / poll: courier data, ordered by the courier's time.
   * admin: an admin's explicit statement (Mark as delivered) – always counts as the latest.
   */
  source: 'webhook' | 'poll' | 'admin';
  actor?: ActorContext;
}

export type TrackingResult = 'applied' | 'stale' | 'unknown' | 'ignored';

const ACTIVE_STATUSES: readonly OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];

async function findShipment(u: TrackingUpdate): Promise<Shipment | null> {
  if (u.awb) {
    const byAwb = await prisma.shipment.findUnique({ where: { awb: u.awb } });
    if (byAwb) return byAwb;
  }
  if (u.orderNumber) {
    const order = await prisma.order.findUnique({ where: { orderNumber: u.orderNumber } });
    if (order) return prisma.shipment.findFirst({ where: { orderId: order.id, currentStatus: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' } });
  }
  return null;
}

const notifiedList = (s: Shipment): string[] => (Array.isArray(s.notifiedMilestones) ? (s.notifiedMilestones as string[]) : []);

interface PendingNotice {
  milestone: Milestone;
  location?: string | null;
}

export async function applyTrackingUpdate(u: TrackingUpdate): Promise<TrackingResult> {
  const found = await findShipment(u);
  if (!found) {
    logger.warn({ awb: u.awb, orderNumber: u.orderNumber }, 'tracking update for an unknown shipment');
    return 'unknown';
  }
  const actor: ActorContext = u.actor ?? { actor: 'SYSTEM', actorRef: `tracking-${u.source}` };
  const where = u.location ? ` – ${u.location}` : '';
  const status = u.status.toUpperCase().trim();

  const outcome = await withTx(prisma, async (tx) => {
    // Lock the shipment, then read everything fresh.
    await tx.shipment.updateMany({ where: { id: found.id }, data: { updatedAt: new Date() } });
    const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: found.id } });
    const order = await getOrder(tx, shipment.orderId);
    if (!ACTIVE_STATUSES.includes(order.status)) return { result: 'ignored' as const };

    // Courier time decides ordering. An admin's statement always counts as the latest; an update
    // without a courier time is applied but does not move lastEventAt.
    const courierTime = u.source === 'admin' ? new Date(Math.max(Date.now(), (shipment.lastEventAt?.getTime() ?? 0) + 1000)) : (u.at ?? null);
    const last = shipment.lastEventAt;
    if (u.source !== 'admin' && courierTime && last) {
      if (courierTime < last) {
        await recordEvent(tx, { ...actor, orderId: order.id, type: 'SHIPMENT_EVENT', message: `Courier: ${u.status}${where} (older update)` });
        return { result: 'stale' as const };
      }
      // Exactly what we already have (e.g. the poll re-reading the latest scan): nothing new.
      if (courierTime.getTime() === last.getTime() && shipment.currentStatus === status) return { result: 'stale' as const };
    }

    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        currentStatus: status,
        ...(courierTime ? { lastEventAt: courierTime } : {}),
        rawPayload: (u.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    await recordEvent(tx, {
      ...actor,
      orderId: order.id,
      type: 'SHIPMENT_EVENT',
      message: `Courier: ${u.status}${where}`,
      data: { awb: shipment.awb, status: u.status, at: courierTime?.toISOString() ?? null, source: u.source },
    });

    const notices: PendingNotice[] = [];
    let delivered = false;
    const kind = classifyShiprocketStatus(u.status);
    switch (kind.kind) {
      case 'progress': {
        const steps = pathTo(order.status, kind.status);
        for (const step of steps) {
          await transitionOrder(order.id, step, { ...actor, reason: `Courier: ${u.status}` }, tx);
        }
        // Missed pickup update: the dispatch message carries courier + AWB, so send it with the first
        // transit update (out-for-delivery and delivered messages cover it themselves).
        if (steps.includes('SHIPPED') && kind.status === 'IN_TRANSIT') notices.push({ milestone: 'SHIPPED' });
        if (steps.length > 0 || kind.status === order.status) notices.push({ milestone: kind.status, location: u.location });
        delivered = kind.status === 'DELIVERED' && steps.includes('DELIVERED');
        break;
      }
      case 'attempt_failed':
        notices.push({ milestone: 'DELIVERY_ATTEMPT_FAILED' });
        break;
      case 'exception': {
        // Alert when the problem is new or changes – not for every further scan of the same return.
        const before = classifyShiprocketStatus(shipment.currentStatus ?? '');
        if (before.kind !== 'exception' || before.reason !== kind.reason) {
          await recordEvent(tx, { actor: 'SYSTEM', actorRef: 'tracking', orderId: order.id, type: 'ERROR', message: `Delivery issue: ${kind.reason} (courier: ${u.status}). Check the shipment in Shiprocket; “Close – not delivered” closes the order.` });
        }
        break;
      }
      case 'info':
        break;
    }

    // Claim the notices inside the lock, so a concurrent update cannot send the same one again.
    const settings = await getSettings();
    const already = notifiedList(shipment);
    const keyFor = (n: PendingNotice) =>
      n.milestone === 'DELIVERY_ATTEMPT_FAILED' ? `DELIVERY_ATTEMPT_FAILED@${courierTime?.toISOString() ?? status}` : n.milestone;
    const toSend = notices.filter((n) => settings.notify[n.milestone] && !already.includes(keyFor(n)));
    if (toSend.length > 0) {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: { notifiedMilestones: [...already, ...toSend.map(keyFor)] as Prisma.InputJsonValue },
      });
    }
    return { result: 'applied' as const, orderId: order.id, shipmentId: shipment.id, toSend, delivered };
  });

  if (outcome.result !== 'applied') return outcome.result;
  for (const notice of outcome.toSend) await notifyMilestone(outcome.orderId, outcome.shipmentId, notice);
  if (outcome.delivered) await scheduleFeedback(outcome.orderId);
  return 'applied';
}

// ─────────────────────────────────────────────────────────────
// Customer notifications
// ─────────────────────────────────────────────────────────────

function template(name: string, values: string[], urlSuffix?: string): () => TemplateMessage {
  return () => ({ name, language: env.WHATSAPP_TEMPLATE_LANGUAGE, components: templateComponents(values, [], urlSuffix) });
}

async function notifyMilestone(orderId: string, shipmentId: string, notice: PendingNotice) {
  const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });
  const orderNumber = order.orderNumber ?? order.requestNumber;
  const name = copy.firstName(order.customer.name);
  const awb = shipment.awb ?? '';
  const trackUrl = shipment.trackingUrl ?? `https://shiprocket.co/tracking/${awb}`;
  const track = (body: string): OutboundMessage =>
    awb ? { kind: 'cta_url', body, buttonText: copy.TRACK_BUTTON, url: trackUrl } : { kind: 'text', body };

  const [session, tpl]: [OutboundMessage, () => TemplateMessage] = (() => {
    switch (notice.milestone) {
      case 'SHIPPED':
        return [
          track(copy.dispatched({ orderNumber, courier: shipment.courierName ?? 'Courier', awb })),
          template(env.TEMPLATE_ORDER_DISPATCHED, [name, orderNumber, shipment.courierName ?? 'Courier', awb], awb),
        ];
      case 'IN_TRANSIT':
        return [track(copy.inTransit({ orderNumber, location: notice.location })), template(env.TEMPLATE_IN_TRANSIT, [name, orderNumber], awb)];
      case 'OUT_FOR_DELIVERY':
        return [track(copy.outForDelivery({ orderNumber })), template(env.TEMPLATE_OUT_FOR_DELIVERY, [name, orderNumber], awb)];
      case 'DELIVERY_ATTEMPT_FAILED':
        return [{ kind: 'text', body: copy.deliveryAttemptFailed({ orderNumber }) }, template(env.TEMPLATE_DELIVERY_ATTEMPT, [name, orderNumber])];
      case 'DELIVERED':
        return [{ kind: 'text', body: copy.delivered({ orderNumber }) }, template(env.TEMPLATE_ORDER_DELIVERED, [name, orderNumber])];
    }
  })();

  try {
    await sendWithFallback({ customer: order.customer, orderId, session, template: tpl });
  } catch (err) {
    // Logged on the order (red alert) by the messaging service; the status change itself stands.
    logger.warn({ err, orderId, milestone: notice.milestone }, 'shipment notification failed');
  }
}

// ─────────────────────────────────────────────────────────────
// Feedback / Instagram follow-up
// ─────────────────────────────────────────────────────────────

const FEEDBACK_JOB = 'feedback.request';

async function scheduleFeedback(orderId: string) {
  const settings = await getSettings();
  const delay = settings.feedback.enabled ? settings.feedback.delayHours : 0;
  await scheduleJob(prisma, { type: FEEDBACK_JOB, orderId, runAt: new Date(Date.now() + delay * 60 * 60 * 1000) });
}

registerJobHandler(FEEDBACK_JOB, async (job) => {
  const order = await prisma.order.findUnique({ where: { id: job.orderId! }, include: { customer: true } });
  if (!order || order.status !== 'DELIVERED') return;
  const settings = await getSettings();

  // Complete first, then send: a message that cannot be delivered must not keep the order open,
  // and a retry must not send the feedback twice.
  await transitionOrder(order.id, 'COMPLETED', {
    actor: 'SYSTEM',
    actorRef: 'follow-up',
    reason: settings.feedback.enabled ? 'Delivered – feedback and Instagram follow-up sent' : 'Delivered',
    expectedVersion: order.version,
  });
  if (!settings.feedback.enabled) return;

  const body = copy.feedbackRequest({ customerName: order.customer.name, instagramHandle: settings.instagramHandle, reviewUrl: settings.reviewUrl || undefined });
  const session: OutboundMessage = settings.instagramHandle
    ? { kind: 'cta_url', body, buttonText: copy.INSTAGRAM_BUTTON, url: instagramUrl(settings.instagramHandle) }
    : { kind: 'text', body };
  await sendWithFallback({
    customer: order.customer,
    orderId: order.id,
    session,
    // The template's Instagram button has a fixed URL, so only the name is filled in.
    template: template(env.TEMPLATE_FEEDBACK_REQUEST, [copy.firstName(order.customer.name)]),
  }).catch((err) => logger.warn({ err, orderId: order.id }, 'feedback message failed'));
});

// ─────────────────────────────────────────────────────────────
// Polling (safety net for missed webhooks) and admin actions
// ─────────────────────────────────────────────────────────────

/** Asks Shiprocket for the latest status of one order's shipment and applies it (courier time). */
export async function refreshTracking(orderId: string, actor?: ActorContext): Promise<TrackingResult> {
  const shipment = await prisma.shipment.findFirst({ where: { orderId, awb: { not: null }, currentStatus: { not: 'CANCELLED' } } });
  if (!shipment?.awb) throw new ConflictError('This order has no AWB to track yet');
  const info = await integrations().shiprocket.track(shipment.awb);
  if (info.trackingUrl && info.trackingUrl !== shipment.trackingUrl) {
    await prisma.shipment.update({ where: { id: shipment.id }, data: { trackingUrl: info.trackingUrl } });
  }
  const latest = [...info.events].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!latest) return 'stale'; // no dated courier scan yet – nothing to apply
  return applyTrackingUpdate({ awb: shipment.awb, status: latest.status, at: latest.at, location: latest.location, source: 'poll', actor });
}

/** Admin marks an order delivered by hand (e.g. confirmed with the customer; courier data missing). */
export async function markDelivered(orderId: string, adminId: string) {
  const order = await getOrder(prisma, orderId);
  const shipment = await prisma.shipment.findFirst({ where: { orderId, currentStatus: { not: 'CANCELLED' } } });
  if (!shipment) throw new NotFoundError('Shipment for order', orderId);
  if (!['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(order.status)) {
    throw new ConflictError('Only shipped orders can be marked as delivered');
  }
  return applyTrackingUpdate({ awb: shipment.awb ?? undefined, orderNumber: order.orderNumber ?? undefined, status: 'DELIVERED', source: 'admin', actor: { actor: 'ADMIN', actorRef: adminId } });
}

const POLL_JOB = 'tracking.poll';
const POLL_EVERY_MS = 4 * 60 * 60 * 1000;
/** Stop a poll run after this long so it never holds up other background jobs for minutes. */
const POLL_BUDGET_MS = 2 * 60 * 1000;
/** Courier statuses after which the parcel is not coming to the customer – no point polling. */
const EXCEPTION_PREFIXES = ['RTO', 'RETURN', 'LOST', 'DAMAGED', 'DESTROYED', 'DISPOSED', 'CANCEL'];

async function scheduleNextPoll(excludeJobId?: string) {
  const pending = await prisma.scheduledJob.count({
    where: { type: POLL_JOB, status: { in: ['PENDING', 'RUNNING'] }, ...(excludeJobId ? { id: { not: excludeJobId } } : {}) },
  });
  if (pending === 0) await scheduleJob(prisma, { type: POLL_JOB, runAt: new Date(Date.now() + POLL_EVERY_MS) });
}

registerJobHandler(POLL_JOB, async (job) => {
  const started = Date.now();
  try {
    const quietSince = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const shipments = await prisma.shipment.findMany({
      where: {
        awb: { not: null },
        order: { status: { in: ['PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] } },
        NOT: EXCEPTION_PREFIXES.map((p) => ({ currentStatus: { startsWith: p } })),
        OR: [{ lastEventAt: null }, { lastEventAt: { lt: quietSince } }],
      },
      orderBy: { lastEventAt: 'asc' }, // longest silent first
      take: 100,
    });
    for (const s of shipments) {
      if (Date.now() - started > POLL_BUDGET_MS) break;
      await refreshTracking(s.orderId).catch((err) => logger.warn({ err, orderId: s.orderId }, 'tracking poll failed for one shipment'));
    }
  } catch (err) {
    // Never fail the poll job: a failed run would be retried *and* reschedule itself (two chains).
    logger.error({ err }, 'tracking poll run failed');
  } finally {
    await scheduleNextPoll(job.id);
  }
});

/** Makes sure the recurring tracking poll is scheduled (called at startup). */
export async function ensureTrackingPoll(): Promise<void> {
  await scheduleNextPoll();
}
