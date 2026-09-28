import { Router } from 'express';
import { integrations } from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import { processWhatsAppWebhook } from '../services/whatsappInbound.js';

export const whatsappWebhookRouter = Router();

/** Meta's subscription handshake (Meta App → WhatsApp → Configuration → Webhook). */
whatsappWebhookRouter.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && typeof token === 'string' && integrations().whatsapp.verifySubscriptionToken(token)) {
    res.status(200).type('text/plain').send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

whatsappWebhookRouter.post('/webhooks/whatsapp', async (req, res, next) => {
  const signature = req.get('x-hub-signature-256');
  if (!req.rawBody || !integrations().whatsapp.verifyWebhookSignature(req.rawBody, signature)) {
    logger.warn({ ip: req.ip }, 'rejected WhatsApp webhook with invalid signature');
    res.sendStatus(401);
    return;
  }
  try {
    const result = await processWhatsAppWebhook(req.body);
    // If an event failed, answer with an error so Meta redelivers the batch later. Events that were
    // processed are skipped on redelivery; the failed one is retried. Without this a temporary
    // database error could silently lose a customer's cart or tap.
    res.status(result.failed > 0 ? 500 : 200).json({ received: true, ...result });
  } catch (err) {
    // Storage failure: a non-200 makes Meta redeliver later.
    next(err);
  }
});
