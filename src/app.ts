import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { ZodError } from 'zod';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { adminApiRouter } from './routes/admin/index.js';
import { healthRouter } from './routes/health.js';
import { razorpayWebhookRouter } from './routes/razorpayWebhook.js';
import { trackingWebhookRouter } from './routes/trackingWebhook.js';
import { whatsappWebhookRouter } from './routes/whatsappWebhook.js';

declare module 'http' {
  interface IncomingMessage {
    /** Exact request bytes – needed to verify Meta / Razorpay webhook signatures */
    rawBody?: Buffer;
  }
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: Request, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(healthRouter);
  app.use(whatsappWebhookRouter);
  app.use(razorpayWebhookRouter);
  app.use(trackingWebhookRouter);
  app.use('/api/admin', adminApiRouter);

  // Admin dashboard (built with `npm run admin:build`)
  const adminDist = path.resolve(process.cwd(), 'admin', 'dist');
  if (existsSync(adminDist)) {
    // Built assets have content hashes in their names, so they can be cached for good;
    // index.html must always be revalidated so admins get the new dashboard after a deploy.
    app.use('/admin/assets', express.static(path.join(adminDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use('/admin', express.static(adminDist, { index: false, maxAge: 0 }));
    app.get(['/admin', '/admin/*'], (_req, res) =>
      res.sendFile(path.join(adminDist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }),
    );
    app.get('/', (_req, res) => res.redirect('/admin'));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) logger.error({ err, path: req.path }, err.message);
      res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const message = first ? `${first.path.length ? `${first.path.join('.')}: ` : ''}${first.message}` : 'Invalid request';
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, details: err.issues } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
      return;
    }
    logger.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  };
  app.use(errorHandler);

  return app;
}
