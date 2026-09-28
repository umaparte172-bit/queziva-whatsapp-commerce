import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

/** An event claimed longer ago than this without finishing is treated as abandoned (process died). */
const IN_FLIGHT_MS = 5 * 60 * 1000;

/**
 * Stores an incoming webhook event once per (source, externalId) and claims it for processing.
 * Returns the row id to process, or null when there is nothing to do:
 *   - already processed successfully (providers deliver webhooks at least once);
 *   - currently being processed by another request (a redelivery must not run it twice at once).
 * An event whose earlier attempt failed – or was abandoned – is claimed again so it can be retried.
 * `receivedAt` doubles as "last claimed at".
 */
export async function claimWebhook(source: string, externalId: string, eventType: string, payload: unknown): Promise<string | null> {
  const key = { source, externalId };
  const existing = await prisma.webhookEvent.findUnique({ where: { source_externalId: key } });
  if (existing) {
    if (existing.processedAt) return null;
    const failed = existing.error !== null;
    const abandoned = existing.receivedAt.getTime() < Date.now() - IN_FLIGHT_MS;
    if (!failed && !abandoned) return null; // in flight elsewhere
    const { count } = await prisma.webhookEvent.updateMany({
      where: { id: existing.id, processedAt: null, receivedAt: existing.receivedAt },
      data: { receivedAt: new Date(), error: null },
    });
    return count === 1 ? existing.id : null;
  }

  try {
    const row = await prisma.webhookEvent.create({ data: { ...key, eventType, payload: payload as Prisma.InputJsonValue } });
    return row.id;
  } catch (err) {
    // Two concurrent deliveries of the same event: the other one owns it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/** Runs the handler for a claimed event and records the outcome. Returns false when it failed. */
export async function processClaimed(webhookEventId: string, label: string, handler: () => Promise<void>): Promise<boolean> {
  try {
    await handler();
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processedAt: new Date(), error: null } });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, event: label }, 'failed to process webhook event');
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { error: message.slice(0, 1000) } });
    return false;
  }
}
