import type { Customer, Prisma } from '@prisma/client';
import { integrations } from '../integrations/index.js';
import type {
  AddressPrefill,
  ButtonMessage,
  CtaUrlMessage,
  ImageMessage,
  OrderDetailsMessage,
  OrderStatusMessage,
  SendResult,
  TemplateMessage,
} from '../integrations/whatsapp/types.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma, type Db } from '../lib/prisma.js';
import { recordEvent } from './audit.js';

export type OutboundMessage =
  | { kind: 'text'; body: string }
  | ({ kind: 'image' } & ImageMessage)
  | ({ kind: 'buttons' } & ButtonMessage)
  | ({ kind: 'cta_url' } & CtaUrlMessage)
  | { kind: 'template'; template: TemplateMessage }
  | { kind: 'address'; body: string; prefill?: AddressPrefill; validationErrors?: Record<string, string> }
  | { kind: 'order_details'; order: OrderDetailsMessage }
  | { kind: 'order_status'; status: OrderStatusMessage };

/** WhatsApp's customer service window: free-form messages only within 24h of the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class OutsideServiceWindowError extends AppError {
  constructor(waId: string) {
    super(
      `More than 24 hours since ${waId} last messaged – send an approved template message instead`,
      409,
      'OUTSIDE_SERVICE_WINDOW',
    );
  }
}

export function isWithinServiceWindow(customer: Pick<Customer, 'lastInboundAt'>, now = new Date()): boolean {
  return !!customer.lastInboundAt && now.getTime() - customer.lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

function dispatch(to: string, m: OutboundMessage): Promise<SendResult> {
  const { whatsapp } = integrations();
  switch (m.kind) {
    case 'text':
      return whatsapp.sendText(to, m.body);
    case 'image':
      return whatsapp.sendImage(to, m);
    case 'buttons':
      return whatsapp.sendButtons(to, m);
    case 'cta_url':
      return whatsapp.sendCtaUrl(to, m);
    case 'template':
      return whatsapp.sendTemplate(to, m.template);
    case 'address':
      return whatsapp.sendAddressRequest(to, m.body, m.prefill, m.validationErrors);
    case 'order_details':
      return whatsapp.sendOrderDetails(to, m.order);
    case 'order_status':
      return whatsapp.sendOrderStatus(to, m.status);
  }
}

function summarise(m: OutboundMessage): string {
  switch (m.kind) {
    case 'text':
    case 'address':
      return m.body;
    case 'image':
      return `${m.caption ?? 'Product image'} [${m.imageUrl}]`;
    case 'buttons':
      return `${m.body} [${m.buttons.map((b) => b.title).join(' | ')}]`;
    case 'cta_url':
      return `${m.body} [${m.buttonText} → ${m.url}]`;
    case 'template':
      return `template ${m.template.name}`;
    case 'order_details':
      return `order_details ${m.order.referenceId} total ${m.order.totalPaise}`;
    case 'order_status':
      return `order_status ${m.status.referenceId} → ${m.status.status}`;
  }
}

export interface SendOptions {
  customer: Pick<Customer, 'id' | 'waId' | 'lastInboundAt'>;
  orderId?: string;
  message: OutboundMessage;
}

/**
 * Sends a WhatsApp message to a customer and logs it (Message row + order audit event).
 * Free-form messages are refused outside the 24-hour service window.
 * Failures are logged and re-thrown so the caller can decide what to do.
 */
export async function sendToCustomer(opts: SendOptions, db: Db = prisma): Promise<SendResult> {
  const { customer, orderId, message } = opts;

  if (message.kind !== 'template' && !isWithinServiceWindow(customer)) {
    throw new OutsideServiceWindowError(customer.waId);
  }

  const payload = message as unknown as Prisma.InputJsonValue;
  try {
    const result = await dispatch(customer.waId, message);
    await db.message.create({
      data: {
        direction: 'OUTBOUND',
        customerId: customer.id,
        orderId,
        waMessageId: result.messageId,
        type: message.kind,
        payload,
        status: 'sent',
      },
    });
    if (orderId) {
      await recordEvent(db, {
        actor: 'SYSTEM',
        orderId,
        type: 'MESSAGE_SENT',
        message: summarise(message).slice(0, 500),
        data: { waMessageId: result.messageId, kind: message.kind },
      });
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: customer.waId, kind: message.kind, orderId }, 'WhatsApp send failed');
    await db.message.create({
      data: { direction: 'OUTBOUND', customerId: customer.id, orderId, type: message.kind, payload, status: 'failed', error },
    });
    if (orderId) {
      await recordEvent(db, {
        actor: 'SYSTEM',
        orderId,
        type: 'ERROR',
        message: `Failed to send ${message.kind}: ${error}`.slice(0, 500),
      });
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Templates (for messages outside the 24-hour window)
// ─────────────────────────────────────────────────────────────

/** Template variables may not contain newlines, tabs or 4+ consecutive spaces. */
export function templateText(value: string, max = 900): string {
  const flat = value.replace(/[\r\n\t]+/g, ' · ').replace(/ {2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || '-';
}

/**
 * Builds template components: body variables, a payload for each quick-reply button, and
 * optionally the variable part of a URL button (e.g. the AWB in https://shiprocket.co/tracking/{{1}}).
 */
export function templateComponents(bodyValues: string[], quickReplyPayloads: string[] = [], urlButtonSuffix?: string): unknown[] {
  return [
    { type: 'body', parameters: bodyValues.map((v) => ({ type: 'text', text: templateText(v) })) },
    ...quickReplyPayloads.map((payload, index) => ({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload }],
    })),
    ...(urlButtonSuffix !== undefined
      ? [{ type: 'button', sub_type: 'url', index: String(quickReplyPayloads.length), parameters: [{ type: 'text', text: urlButtonSuffix }] }]
      : []),
  ];
}

/**
 * Sends the interactive message while the 24-hour window is open; otherwise sends the
 * approved template, whose quick-reply buttons re-open the conversation.
 */
export async function sendWithFallback(
  opts: { customer: SendOptions['customer']; orderId?: string; session: OutboundMessage; template: () => TemplateMessage },
  db: Db = prisma,
): Promise<SendResult & { usedTemplate: boolean }> {
  const usedTemplate = !isWithinServiceWindow(opts.customer);
  const message: OutboundMessage = usedTemplate ? { kind: 'template', template: opts.template() } : opts.session;
  const result = await sendToCustomer({ customer: opts.customer, orderId: opts.orderId, message }, db);
  return { ...result, usedTemplate };
}

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/**
 * Applies a delivery status from the webhook. Statuses can arrive out of order, so a message
 * never moves backwards (read → delivered); "failed" always wins.
 */
export async function applyMessageStatus(
  waMessageId: string,
  status: string,
  error?: string,
  db: Db = prisma,
): Promise<boolean> {
  const message = await db.message.findUnique({ where: { waMessageId } });
  if (!message) return false;

  const current = STATUS_RANK[message.status ?? ''] ?? 0;
  const next = STATUS_RANK[status] ?? 0;
  if (status !== 'failed' && (message.status === 'failed' || next <= current)) return true;

  await db.message.update({ where: { id: message.id }, data: { status, error: error ?? message.error } });

  if (status === 'failed' && message.orderId) {
    await recordEvent(db, {
      actor: 'SYSTEM',
      orderId: message.orderId,
      type: 'ERROR',
      message: `WhatsApp could not deliver ${message.type} message${error ? `: ${error}` : ''}`.slice(0, 500),
    });
  }
  return true;
}
