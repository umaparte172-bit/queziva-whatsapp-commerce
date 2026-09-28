import type { Prisma, ScheduledJob } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { prisma, type Db } from '../lib/prisma.js';

/**
 * Minimal persistent job queue on the ScheduledJob table – used for reminders and
 * timeouts. Jobs survive restarts; each run is claimed atomically so it executes once
 * even if several server instances poll at the same time.
 */

export type JobHandler = (job: ScheduledJob) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function scheduleJob(
  db: Db,
  job: { type: string; runAt: Date; orderId?: string; payload?: Prisma.InputJsonValue },
): Promise<ScheduledJob> {
  return db.scheduledJob.create({ data: job });
}

/** Cancels pending jobs for an order (optionally only some types). */
export async function cancelJobs(db: Db, orderId: string, types?: string[]): Promise<number> {
  const { count } = await db.scheduledJob.updateMany({
    where: { orderId, status: 'PENDING', ...(types ? { type: { in: types } } : {}) },
    data: { status: 'CANCELLED' },
  });
  return count;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
/** A job stuck in RUNNING this long (process crashed mid-run) is picked up again. */
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Runs every job that is due. Returns how many ran. */
export async function runDueJobs(now = new Date(), limit = 25, onlyOrderIds?: string[]): Promise<number> {
  const due = await prisma.scheduledJob.findMany({
    where: {
      OR: [
        { status: 'PENDING', runAt: { lte: now } },
        { status: 'RUNNING', lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
      ],
      // The simulator's "skip ahead" must only touch its own orders, never real customers' jobs.
      ...(onlyOrderIds ? { orderId: { in: onlyOrderIds } } : {}),
    },
    orderBy: { runAt: 'asc' },
    take: limit,
  });

  let ran = 0;
  for (const job of due) {
    const { count } = await prisma.scheduledJob.updateMany({
      where: { id: job.id, status: job.status, lockedAt: job.lockedAt },
      data: { status: 'RUNNING', lockedAt: now, attempts: { increment: 1 } },
    });
    if (count === 0) continue; // another worker took it

    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      await handler(job);
      await prisma.scheduledJob.update({ where: { id: job.id }, data: { status: 'DONE', lastError: null } });
      ran++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS || !handler;
      logger.error({ err, jobId: job.id, type: job.type, attempts }, giveUp ? 'job failed permanently' : 'job failed, will retry');
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: giveUp
          ? { status: 'FAILED', lastError: message.slice(0, 1000) }
          : { status: 'PENDING', lockedAt: null, lastError: message.slice(0, 1000), runAt: new Date(now.getTime() + RETRY_DELAY_MS * attempts) },
      });
    }
  }
  return ran;
}

/** Polls for due jobs in the background. Returns a stop function. */
export function startJobRunner(intervalMs = 30_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueJobs();
    } catch (err) {
      logger.error({ err }, 'job runner tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
