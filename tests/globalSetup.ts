import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DB = fileURLToPath(new URL('../prisma/test.db', import.meta.url));
const TEST_DB_URL = `file:${TEST_DB.replace(/\\/g, '/')}?socket_timeout=20`;

/**
 * Prepares the test database before the run.
 *
 * - SQLite (default): creates or synchronizes the dedicated throwaway prisma/test.db. Test
 *   hooks clear its rows; dev.db and configured databases are never removed.
 * - PostgreSQL (TEST_DATABASE_URL): applies the production migrations to what must be an empty,
 *   throwaway database – exactly how production is set up. Nothing is dropped.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;

  if (url) {
    execSync('npx prisma migrate deploy --schema prisma/postgres/schema.prisma', {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    return;
  }

  // `db push` creates the disposable database on a clean checkout and updates an
  // existing one in place. Individual suites clear their data in beforeEach hooks.
  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });

  // WAL mode is stored in the database file and avoids a full disk flush per commit,
  // which makes the DB-heavy tests several times faster on Windows.
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: TEST_DB_URL });
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await db.$disconnect();
}
