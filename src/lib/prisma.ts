import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  // Errors are thrown to the caller and logged there; Prisma's own error log would
  // also print expected failures (e.g. duplicate-key checks).
  log: env.NODE_ENV === 'test' ? [] : ['warn'],
});

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const postgres = env.DATABASE_URL.startsWith('postgres');

/**
 * Case-insensitive "contains" filter. SQLite's LIKE already ignores case (for ASCII); PostgreSQL
 * needs mode: 'insensitive', which the SQLite client does not accept – hence the switch.
 */
export function containsText(value: string): { contains: string } {
  return (postgres ? { contains: value, mode: 'insensitive' } : { contains: value }) as { contains: string };
}
/** A Prisma client or an open transaction – services accept either. */
export type Db = typeof prisma | Tx;
