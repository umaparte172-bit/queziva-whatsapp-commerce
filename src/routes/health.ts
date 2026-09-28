import { Router } from 'express';
import { integrationModes } from '../integrations/index.js';
import { prisma } from '../lib/prisma.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  let database: 'ok' | 'error' = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'error';
  }
  res.status(database === 'ok' ? 200 : 503).json({
    status: database === 'ok' ? 'ok' : 'degraded',
    database,
    integrations: integrationModes(),
    time: new Date().toISOString(),
  });
});
