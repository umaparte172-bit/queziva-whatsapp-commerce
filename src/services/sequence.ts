import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { dateStamp, formatOrderNumber } from '../domain/orderNumber.js';
import type { Db } from '../lib/prisma.js';

/** Atomically increments and returns the counter for `key` (starting at 1). */
export async function nextSequence(db: Db, key: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const counter = await db.counter.upsert({
        where: { key },
        create: { key, value: 1 },
        update: { value: { increment: 1 } },
      });
      return counter.value;
    } catch (err) {
      // Two first-of-the-day requests can race on the insert; the loser retries as an update.
      const isUniqueRace = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!isUniqueRace || attempt >= 2) throw err;
    }
  }
}

async function nextNumber(db: Db, prefix: string, now: Date): Promise<string> {
  const stamp = dateStamp(now, env.TIMEZONE);
  const seq = await nextSequence(db, `${prefix}:${stamp}`);
  return formatOrderNumber(prefix, stamp, seq);
}

/** Reference given to an order request as soon as it arrives, e.g. RQ260928001. */
export function nextRequestNumber(db: Db, now = new Date()): Promise<string> {
  return nextNumber(db, env.REQUEST_ID_PREFIX, now);
}

/** Final Queziva Order ID, assigned when payment is verified, e.g. QZ260928001. */
export function nextOrderNumber(db: Db, now = new Date()): Promise<string> {
  return nextNumber(db, env.ORDER_ID_PREFIX, now);
}
