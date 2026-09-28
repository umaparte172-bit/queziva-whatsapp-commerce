import { Router } from 'express';
import { parseShiprocketTime } from '../domain/tracking.js';
import { integrations } from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import { applyTrackingUpdate } from '../services/tracking.js';
import { claimWebhook, processClaimed } from '../services/webhooks.js';

export const trackingWebhookRouter = Router();

type Json = any;

/**
 * Shiprocket tracking webhook (Settings → API → Webhooks).
 * Shiprocket rejects webhook URLs containing "shiprocket", "kartrocket", "sr" or "kr",
 * hence the neutral path. The token is sent in the x-api-key header.
 */
trackingWebhookRouter.post('/webhooks/tracking', async (req, res, next) => {
  if (!integrations().shiprocket.verifyWebhookToken(req.get('x-api-key'))) {
    logger.warn({ ip: req.ip }, 'rejected tracking webhook with invalid token');
    res.sendStatus(401);
    return;
  }
  try {
    const body: Json = req.body ?? {};
    const status = String(body.current_status ?? body.shipment_status ?? '').trim();
    const awb = body.awb ? String(body.awb) : undefined;
    if (!status || (!awb && !body.order_id)) {
      res.status(200).json({ result: 'ignored' });
      return;
    }

    const scans: Json[] = Array.isArray(body.scans) ? body.scans : [];
    const lastScan = scans.at(-1);
    const at = parseShiprocketTime(body.current_timestamp) ?? parseShiprocketTime(lastScan?.date);
    // Returns travel back to the store – never treat them as the customer's delivery.
    const effectiveStatus = Number(body.is_return) === 1 ? `RETURN ${status}` : status;

    const claimed = await claimWebhook('shiprocket', `${awb ?? body.order_id}:${status}:${body.current_timestamp ?? ''}`, status, body);
    if (!claimed) {
      res.status(200).json({ result: 'duplicate' });
      return;
    }
    await processClaimed(claimed, `tracking.${status}`, async () => {
      await applyTrackingUpdate({
        awb,
        orderNumber: body.order_id ? String(body.order_id) : undefined,
        status: effectiveStatus,
        at,
        location: lastScan?.location ? String(lastScan.location) : null,
        raw: { current_status: status, current_timestamp: body.current_timestamp, courier_name: body.courier_name, etd: body.etd },
        source: 'webhook',
      });
    });
    // Always 200 once authenticated: Shiprocket can disable a webhook that keeps failing, and the
    // tracking poll picks up anything that could not be processed here.
    res.status(200).json({ result: 'received' });
  } catch (err) {
    next(err);
  }
});
