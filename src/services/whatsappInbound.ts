import { Prisma, type Customer } from '@prisma/client';
import { env } from '../config/env.js';
import { integrations } from '../integrations/index.js';
import {
  parseWebhook,
  type InboundMessage,
  type MessageStatusUpdate,
  type PaymentStatusUpdate,
  type WebhookEvent,
} from '../integrations/whatsapp/webhook.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import * as copy from '../messages/copy.js';
import { recordEvent } from './audit.js';
import { handleAddressReply, handleButtonReply, handleText } from './customerFlow.js';
import { applyMessageStatus, sendToCustomer } from './messaging.js';
import { createOrderRequest } from './orders.js';
import { confirmPayment, recordUnverifiableFailure } from './payments.js';
import { claimWebhook, processClaimed } from './webhooks.js';

export interface WebhookResult {
  processed: number;
  duplicates: number;
  ignored: number;
  failed: number;
}

function externalId(event: WebhookEvent): string {
  switch (event.kind) {
    case 'message':
      return event.message.id;
    case 'status':
      return `${event.status.messageId}:${event.status.status}`;
    case 'payment':
      return `${event.payment.messageId}:payment:${event.payment.status}:${event.payment.transactionId ?? ''}`;
  }
}

function eventType(event: WebhookEvent): string {
  switch (event.kind) {
    case 'message':
      return `message.${event.message.kind}`;
    case 'status':
      return `status.${event.status.status}`;
    case 'payment':
      return `payment.${event.payment.status}`;
  }
}

/** Entry point for POST /webhooks/whatsapp (after signature verification). */
export async function processWhatsAppWebhook(body: unknown): Promise<WebhookResult> {
  const result: WebhookResult = { processed: 0, duplicates: 0, ignored: 0, failed: 0 };

  for (const event of parseWebhook(body)) {
    // One WABA can have several numbers; only handle the one this system runs on.
    if (env.WHATSAPP_MODE === 'live' && event.phoneNumberId !== env.WHATSAPP_PHONE_NUMBER_ID) {
      result.ignored++;
      continue;
    }

    const payload = event.kind === 'message' ? event.message.raw : event.kind === 'payment' ? event.payment.raw : event.status;
    const webhookEventId = await claimWebhook('whatsapp', externalId(event), eventType(event), payload);
    if (!webhookEventId) {
      result.duplicates++;
      continue;
    }
    if (await processClaimed(webhookEventId, eventType(event), () => handleEvent(event))) result.processed++;
    else result.failed++;
  }
  return result;
}

function handleEvent(event: WebhookEvent): Promise<void> {
  switch (event.kind) {
    case 'message':
      return handleMessage(event.message, event.profileName);
    case 'status':
      return handleStatus(event.status);
    case 'payment':
      return handlePaymentStatus(event.payment);
  }
}

// ─────────────────────────────────────────────────────────────
// Inbound messages
// ─────────────────────────────────────────────────────────────

async function touchCustomer(waId: string, profileName: string | undefined, at: Date): Promise<Customer> {
  const customer = await prisma.customer.upsert({
    where: { waId },
    create: { waId, name: profileName, lastInboundAt: at },
    update: profileName ? { name: profileName } : {},
  });
  // Webhooks can arrive out of order – never move the service window backwards.
  if (!customer.lastInboundAt || customer.lastInboundAt < at) {
    return prisma.customer.update({ where: { id: customer.id }, data: { lastInboundAt: at } });
  }
  return customer;
}

async function handleMessage(message: InboundMessage, profileName?: string): Promise<void> {
  // Clamp to now: a skewed timestamp must not extend the 24-hour window.
  const receivedAt = message.timestamp > new Date() ? new Date() : message.timestamp;
  const customer = await touchCustomer(message.from, profileName, receivedAt);

  await prisma.message.upsert({
    where: { waMessageId: message.id },
    create: {
      direction: 'INBOUND',
      customerId: customer.id,
      waMessageId: message.id,
      type: message.kind,
      payload: message.raw as Prisma.InputJsonValue,
      status: 'received',
    },
    update: {},
  });

  // Blue ticks – best effort only.
  integrations()
    .whatsapp.markRead(message.id)
    .catch((err) => logger.warn({ err }, 'could not mark message as read'));

  switch (message.kind) {
    case 'order':
      return handleCartOrder(customer, message, profileName);
    case 'button_reply':
    case 'template_button':
      return handleButtonReply(customer, message);
    case 'address':
      return handleAddressReply(customer, message);
    case 'text':
      return handleText(customer, message);
    default:
      logger.info({ from: message.from, kind: message.kind }, 'inbound WhatsApp message stored');
  }
}

/** Customer sent a cart from the WhatsApp catalogue → create an order request for admin review. */
async function handleCartOrder(customer: Customer, message: InboundMessage, profileName?: string): Promise<void> {
  const items = (message.order?.items ?? []).filter((i) => i.retailerId && Number.isInteger(i.quantity) && i.quantity > 0);
  if (items.length === 0) {
    await sendToCustomer({ customer, message: { kind: 'text', body: copy.emptyCart() } });
    return;
  }

  const order = await createOrderRequest({
    waId: customer.waId,
    customerName: profileName,
    catalogId: message.order?.catalogId,
    customerNote: message.order?.note,
    inboundMessageId: message.id,
    rawRequest: message.raw as Prisma.InputJsonValue,
    items: items.map((i) => ({ retailerId: i.retailerId, quantity: i.quantity, unitPricePaise: i.unitPricePaise })),
  });

  await prisma.message.update({ where: { waMessageId: message.id }, data: { orderId: order.id } });

  // Acknowledge once – a retried webhook must not send the confirmation twice.
  const alreadyAcknowledged = await prisma.message.count({ where: { orderId: order.id, direction: 'OUTBOUND' } });
  if (alreadyAcknowledged > 0) return;

  try {
    const body = copy.orderReceived(order);
    const productIds = order.items.flatMap((item) => (item.productId ? [item.productId] : []));
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, imageUrl: { not: null } }, select: { id: true, imageUrl: true } });
    const images = new Map(products.map((product) => [product.id, product.imageUrl]));
    const imageUrl = order.items.map((item) => (item.productId ? images.get(item.productId) : null)).find(Boolean);
    const canUseImageCaption = imageUrl && /^https:\/\/\S+$/.test(imageUrl) && body.length <= 1024;
    const outbound = canUseImageCaption
      ? { kind: 'image' as const, imageUrl, caption: body }
      : { kind: 'text' as const, body };
    await sendToCustomer({ customer, orderId: order.id, message: outbound });
  } catch {
    // Already logged on the order by sendToCustomer; the order itself is safely stored for admin review.
  }
}

// ─────────────────────────────────────────────────────────────
// Statuses
// ─────────────────────────────────────────────────────────────

async function handleStatus(status: MessageStatusUpdate): Promise<void> {
  const error = status.errors
    .map((e) => [e.code, e.title ?? e.message, e.details].filter(Boolean).join(' – '))
    .join('; ');
  await applyMessageStatus(status.messageId, status.status, error || undefined);
}

/**
 * Payment status from WhatsApp for an order_details message. Recorded on the order here;
 * server-side Razorpay verification and marking the order PAID happen in the payment service.
 */
async function handlePaymentStatus(payment: PaymentStatusUpdate): Promise<void> {
  const record = await prisma.payment.findUnique({ where: { referenceId: payment.referenceId } });
  if (!record) {
    logger.warn({ referenceId: payment.referenceId }, 'payment webhook for unknown reference_id');
    return;
  }
  await recordEvent(prisma, {
    actor: 'SYSTEM',
    actorRef: 'whatsapp-webhook',
    orderId: record.orderId,
    type: 'PAYMENT_EVENT',
    message: `WhatsApp payment status: ${payment.status}${payment.errorReason ? ` (${payment.errorReason})` : ''}`,
    data: {
      referenceId: payment.referenceId,
      status: payment.status,
      amountPaise: payment.amountPaise,
      pgTransactionId: payment.pgTransactionId,
      transactionStatus: payment.transactionStatus,
    },
  });

  // The webhook is only a hint: the payment itself is looked up and checked with Razorpay.
  if (payment.pgTransactionId && (payment.status === 'captured' || payment.status === 'failed')) {
    await confirmPayment({ razorpayPaymentId: payment.pgTransactionId, referenceId: payment.referenceId, source: 'whatsapp' });
  } else if (payment.status === 'failed') {
    await recordUnverifiableFailure(payment.referenceId, payment.errorReason ?? 'Payment failed');
  }
}
