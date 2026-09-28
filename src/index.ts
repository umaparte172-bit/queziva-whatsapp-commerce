import { createApp } from './app.js';
import { env } from './config/env.js';
import { integrationModes } from './integrations/index.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
// Modules that register background job handlers
import './services/customerFlow.js';
import './services/fulfilment.js';
import './services/payments.js';
import { ensureTrackingPoll } from './services/tracking.js';
import { startJobRunner } from './services/jobs.js';

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT, integrations: integrationModes() }, `Queziva commerce server listening on ${env.APP_BASE_URL}`);
});

const stopJobs = startJobRunner();
ensureTrackingPoll().catch((err) => logger.error({ err }, 'could not schedule tracking poll'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopJobs();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
