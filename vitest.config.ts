import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Prisma's SQLite schema engine can fail without a useful error on Windows when the
// datasource uses a relative file URL. Keep one absolute URL for the CLI and client.
// Give concurrent SQLite writes enough time to acquire its single-writer lock on CI.
// Production uses PostgreSQL and still exercises true row-level concurrency there.
const sqliteTestUrl = `file:${fileURLToPath(new URL('./prisma/test.db', import.meta.url)).replace(/\\/g, '/')}?socket_timeout=20`;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    env: {
      NODE_ENV: 'test',
      // SQLite by default; set TEST_DATABASE_URL to an EMPTY throwaway PostgreSQL database to run the
      // suite against Postgres (needs the Postgres client: npx prisma generate --schema prisma/postgres/schema.prisma).
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? sqliteTestUrl,
      WHATSAPP_MODE: 'mock',
      RAZORPAY_MODE: 'mock',
      SHIPROCKET_MODE: 'mock',
      PRICES_INCLUDE_GST: 'true',
      SHIPROCKET_PICKUP_PINCODE: '110001',
    },
    // SQLite allows one writer at a time; run test files sequentially.
    fileParallelism: false,
    // The end-to-end tests do dozens of database writes; on a busy Windows disk some take a few
    // seconds, so the 5 s default flakes. 20 s still catches a genuine hang.
    testTimeout: 20_000,
  },
});
