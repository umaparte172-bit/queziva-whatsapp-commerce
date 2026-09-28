import { Router } from 'express';
import { integrations } from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import { processRazorpayWebhook } from '../services/razorpayWebhook.js';

export const razorpayWebhookRouter = Router();

/** Razorpay Dashboard → Settings → Webhooks → URL https://<APP_BASE_URL>/webhooks/razorpay */
razorpayWebhookRouter.post('/webhooks/razorpay', async (req, res, next) => {
  const signature = req.get('x-razorpay-signature') ?? '';
  if (!req.rawBody || !integrations().razorpay.verifyWebhookSignature(req.rawBody, signature)) {
    logger.warn({ ip: req.ip }, 'rejected Razorpay webhook with invalid signature');
    res.sendStatus(401);
    return;
  }
  try {
    const result = await processRazorpayWebhook(req.body, req.get('x-razorpay-event-id'));
    // A failed event stays unprocessed; a non-200 makes Razorpay redeliver it.
    res.status(result === 'failed' ? 500 : 200).json({ result });
  } catch (err) {
    next(err);
  }
});
