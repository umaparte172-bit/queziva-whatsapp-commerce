import { Router } from 'express';
import { AppError } from '../../lib/errors.js';
import { authRouter, requireAdmin } from './auth.js';
import { ordersRouter } from './orders.js';
import { productsRouter } from './products.js';
import { settingsRouter } from './settings.js';
import { simulatorEnabled } from '../../services/simulator.js';
import { simulatorRouter } from './simulator.js';

/** Admin JSON API, mounted at /api/admin. */
export const adminApiRouter = Router();

adminApiRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  // With SameSite=Strict session cookies, insisting on JSON for writes closes off form-based CSRF.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
    next(new AppError('Requests must be sent as JSON', 415, 'UNSUPPORTED_MEDIA_TYPE'));
    return;
  }
  next();
});

adminApiRouter.use(authRouter);
adminApiRouter.use(requireAdmin, ordersRouter);
adminApiRouter.use(requireAdmin, productsRouter);
adminApiRouter.use(requireAdmin, settingsRouter);
// The customer simulator only exists in test mode – with live WhatsApp these routes are not mounted.
if (simulatorEnabled()) adminApiRouter.use(requireAdmin, simulatorRouter);
