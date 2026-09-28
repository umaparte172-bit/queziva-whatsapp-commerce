import type { Customer, Order, OrderItem, Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { fromWhatsAppAddress, validateAddress, type AddressFields, type DeliveryAddress } from '../domain/address.js';
import type { AddressPrefill } from '../integrations/whatsapp/types.js';
import type { InboundMessage } from '../integrations/whatsapp/webhook.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import * as copy from '../messages/copy.js';
import { recordEvent, type ActorContext } from './audit.js';
import { cancelOrder } from './cancellation.js';
import { cancelJobs, registerJobHandler, scheduleJob } from './jobs.js';
import { sendToCustomer, sendWithFallback, templateComponents } from './messaging.js';
import { getOrder, transitionOrder, withTx } from './orders.js';
import { sendPaymentMessage } from './payments.js';
import { quoteShipping, StaleQuoteError, type QuoteResult } from './shipping.js';

/** A shipping quote after an address was saved; 'stale' = a newer address overtook this one. */
export type AddressQuoteResult = QuoteResult | { ok: false; reason: 'stale'; message: string };

/**
 * The customer side of the order workflow on WhatsApp:
 *
 *   admin approves ─┬─ unchanged → ask for delivery address
 *                   └─ changed   → send revised order with [Accept] [Cancel]
 *   customer accepts → ask for delivery address
 *   customer sends address → validate, save, acknowledge (shipping is calculated next)
 *
 * plus reminders and auto-cancel when the customer does not respond.
 */

type OrderWithCustomer = Order & { customer: Customer; items: OrderItem[] };

const JOB = {
  approvalReminder: 'approval.reminder',
  approvalTimeout: 'approval.timeout',
  addressReminder: 'address.reminder',
  addressTimeout: 'address.timeout',
} as const;

const APPROVAL_JOBS = [JOB.approvalReminder, JOB.approvalTimeout];
const ADDRESS_JOBS = [JOB.addressReminder, JOB.addressTimeout];

const hours = (h: number) => h * 60 * 60 * 1000;

async function loadOrder(orderId: string): Promise<OrderWithCustomer> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true, items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  if (!order) throw new NotFoundError('Order', orderId);
  return order;
}

// ─────────────────────────────────────────────────────────────
// Button ids – carry the order and approval round so stale taps are detectable
// ─────────────────────────────────────────────────────────────

type ButtonAction = 'accept' | 'cancel' | 'address' | 'pay';

export function buttonId(action: ButtonAction, orderId: string, round = 0): string {
  return `qz:${action}:${orderId}:${round}`;
}

export function parseButtonId(id: string): { action: ButtonAction; orderId: string; round: number } | null {
  const m = /^qz:(accept|cancel|address|pay):([A-Za-z0-9_-]+):(\d+)$/.exec(id);
  return m ? { action: m[1] as ButtonAction, orderId: m[2]!, round: Number(m[3]) } : null;
}

// ─────────────────────────────────────────────────────────────
// Outbound: revised order for approval
// ─────────────────────────────────────────────────────────────

/**
 * Sends the revised order with Accept / Cancel buttons (or the approved template when the
 * 24-hour window has closed). The buttons carry the current approval round, which the approve
 * action increments in the same transaction that moves the order to AWAITING_CUSTOMER_APPROVAL –
 * so buttons from earlier versions never match.
 */
export async function sendRevisionForApproval(orderId: string, opts: { startTimers?: boolean; reminder?: boolean } = {}) {
  const order = await loadOrder(orderId);
  if (order.status !== 'AWAITING_CUSTOMER_APPROVAL') {
    throw new ConflictError('The order is not waiting for customer approval');
  }
  if (opts.startTimers) {
    // Before sending, so a failed send still leaves the reminder and timeout in place.
    await cancelJobs(prisma, orderId, APPROVAL_JOBS);
    await scheduleResponseJobs(order.id, 'approval', order.approvalRound);
  }

  const round = order.approvalRound;
  const content = {
    customerName: order.customer.name,
    requestNumber: order.requestNumber,
    items: order.items,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
  };
  const body = opts.reminder ? `${copy.approvalReminder(order.requestNumber)}\n\n${copy.revisedOrder(content)}`.slice(0, 1024) : copy.revisedOrder(content);

  return sendWithFallback({
    customer: order.customer,
    orderId,
    session: {
      kind: 'buttons',
      header: copy.REVISED_ORDER_HEADER(),
      body,
      buttons: [
        { id: buttonId('accept', orderId, round), title: copy.BUTTON_ACCEPT },
        { id: buttonId('cancel', orderId, round), title: copy.BUTTON_CANCEL },
      ],
    },
    template: () => ({
      name: env.TEMPLATE_ORDER_UPDATE,
      language: env.WHATSAPP_TEMPLATE_LANGUAGE,
      components: templateComponents(copy.revisedOrderTemplateValues(content), [
        buttonId('accept', orderId, round),
        buttonId('cancel', orderId, round),
      ]),
    }),
  });
}

// ─────────────────────────────────────────────────────────────
// Outbound: address request
// ─────────────────────────────────────────────────────────────

function prefillFor(order: OrderWithCustomer): AddressPrefill {
  const saved = (order.customer.savedAddress ?? null) as Partial<DeliveryAddress> | null;
  if (saved?.pincode) {
    return {
      name: saved.name,
      phoneNumber: saved.phone,
      inPinCode: saved.pincode,
      houseNumber: saved.house,
      address: saved.street,
      landmarkArea: saved.landmark,
      city: saved.city,
      state: saved.state,
    };
  }
  const phone = order.customer.waId.startsWith('91') ? order.customer.waId.slice(2) : order.customer.waId;
  return { name: order.customer.name ?? undefined, phoneNumber: phone };
}

export async function sendAddressRequest(
  orderId: string,
  reason: 'approved' | 'accepted' | 'reminder' | 'retry' | 'nudge' | 'unserviceable',
  extra: { prefill?: AddressPrefill; validationErrors?: Record<string, string>; body?: string } = {},
) {
  const order = await loadOrder(orderId);
  // Also during the final review: a customer correcting their address there may need the form again.
  if (!(ADDRESS_STATUSES as readonly string[]).includes(order.status)) throw new ConflictError('The order is not waiting for an address');

  return sendWithFallback({
    customer: order.customer,
    orderId,
    session: {
      kind: 'address',
      body:
        extra.body ??
        copy.addressRequest({ customerName: order.customer.name, requestNumber: order.requestNumber }, reason === 'unserviceable' ? 'retry' : reason),
      prefill: extra.prefill ?? prefillFor(order),
      validationErrors: extra.validationErrors,
    },
    template: () => ({
      name: env.TEMPLATE_ADDRESS_REQUEST,
      language: env.WHATSAPP_TEMPLATE_LANGUAGE,
      components: templateComponents(
        copy.addressTemplateValues({ customerName: order.customer.name, requestNumber: order.requestNumber }),
        [buttonId('address', orderId)],
      ),
    }),
  });
}

// ─────────────────────────────────────────────────────────────
// Reminders / timeouts
// ─────────────────────────────────────────────────────────────

async function scheduleResponseJobs(orderId: string, stage: 'approval' | 'address', round = 0) {
  const now = Date.now();
  const [reminderH, timeoutH, types] =
    stage === 'approval'
      ? [env.APPROVAL_REMINDER_HOURS, env.APPROVAL_TIMEOUT_HOURS, [JOB.approvalReminder, JOB.approvalTimeout]]
      : [env.ADDRESS_REMINDER_HOURS, env.ADDRESS_TIMEOUT_HOURS, [JOB.addressReminder, JOB.addressTimeout]];
  const payload = { round };
  if (reminderH > 0 && (timeoutH === 0 || reminderH < timeoutH)) {
    await scheduleJob(prisma, { type: types[0]!, orderId, runAt: new Date(now + hours(reminderH)), payload });
  }
  if (timeoutH > 0) {
    await scheduleJob(prisma, { type: types[1]!, orderId, runAt: new Date(now + hours(timeoutH)), payload });
  }
}

function jobRound(payload: Prisma.JsonValue | null): number {
  return typeof payload === 'object' && payload && !Array.isArray(payload) ? Number(payload.round ?? 0) : 0;
}

function hasAddress(order: Order): boolean {
  return Boolean(order.shipPincode);
}

registerJobHandler(JOB.approvalReminder, async (job) => {
  const order = await getOrder(prisma, job.orderId!);
  if (order.status !== 'AWAITING_CUSTOMER_APPROVAL' || order.approvalRound !== jobRound(job.payload)) return;
  await sendRevisionForApproval(order.id, { reminder: true });
});

// Timeouts pass the version they checked: if the customer answers (or an admin edits) at the
// same moment, the cancel fails with a conflict, the job retries, and then sees the new state.
registerJobHandler(JOB.approvalTimeout, async (job) => {
  const order = await getOrder(prisma, job.orderId!);
  if (order.status !== 'AWAITING_CUSTOMER_APPROVAL' || order.approvalRound !== jobRound(job.payload)) return;
  await cancelOrder(
    order.id,
    { actor: 'SYSTEM', actorRef: 'approval-timeout', expectedVersion: order.version },
    'No response to the revised order',
    'timeout',
  );
});

registerJobHandler(JOB.addressReminder, async (job) => {
  const order = await getOrder(prisma, job.orderId!);
  if (order.status !== 'AWAITING_ADDRESS' || hasAddress(order)) return;
  await sendAddressRequest(order.id, 'reminder');
});

registerJobHandler(JOB.addressTimeout, async (job) => {
  const order = await getOrder(prisma, job.orderId!);
  if (order.status !== 'AWAITING_ADDRESS' || hasAddress(order)) return;
  await cancelOrder(
    order.id,
    { actor: 'SYSTEM', actorRef: 'address-timeout', expectedVersion: order.version },
    'No delivery address received',
    'timeout',
  );
});

// ─────────────────────────────────────────────────────────────
// After admin actions
// ─────────────────────────────────────────────────────────────

/**
 * Called after an admin approves an order. Sends the right WhatsApp message and starts the
 * response timers. Returns a warning when the message could not be sent (the order change stands).
 */
export async function afterAdminApproval(orderId: string): Promise<string | undefined> {
  const order = await getOrder(prisma, orderId);
  try {
    if (order.status === 'AWAITING_CUSTOMER_APPROVAL') {
      await sendRevisionForApproval(orderId, { startTimers: true });
    } else if (order.status === 'AWAITING_ADDRESS') {
      // Timers first, so a failed send still ends in a reminder or an auto-cancel.
      await scheduleResponseJobs(orderId, 'address');
      await sendAddressRequest(orderId, 'approved');
    }
    return undefined;
  } catch (err) {
    return `Order updated, but the WhatsApp message failed: ${err instanceof Error ? err.message : err}. Use “Resend WhatsApp message”.`;
  }
}

/** Re-sends whatever the customer is currently being asked for. */
export async function resendCurrentRequest(orderId: string): Promise<void> {
  const order = await getOrder(prisma, orderId);
  if (order.status === 'AWAITING_CUSTOMER_APPROVAL') await sendRevisionForApproval(orderId);
  else if (order.status === 'AWAITING_ADDRESS') await sendAddressRequest(orderId, 'reminder');
  else if (order.status === 'PAYMENT_REQUESTED') await sendPaymentMessage(orderId, 'reminder');
  else throw new ConflictError('There is nothing waiting for the customer on this order');
}

/** Admin edited a revised order after sending it – buttons from the old version must stop working. */
export async function onRevisionWithdrawn(orderId: string): Promise<void> {
  await cancelJobs(prisma, orderId, APPROVAL_JOBS);
}

// ─────────────────────────────────────────────────────────────
// Address saving (customer form or admin entry)
// ─────────────────────────────────────────────────────────────

/** Statuses in which the delivery address may be given or changed. */
const ADDRESS_STATUSES = ['AWAITING_ADDRESS', 'READY_FOR_PAYMENT'] as const;

export interface SaveAddressResult {
  address?: DeliveryAddress;
  errors: Record<string, string>;
  shipping?: AddressQuoteResult;
}

/**
 * Validates and stores the delivery address, then calculates shipping. Changing the address
 * during the final review sends the order back a step so shipping is quoted again.
 */
export async function saveAddress(
  orderId: string,
  fields: AddressFields,
  ctx: ActorContext & { expectedVersion?: number },
): Promise<SaveAddressResult> {
  const { address, errors } = validateAddress(fields);
  if (!address) return { errors };

  await withTx(prisma, async (tx) => {
    let order = await getOrder(tx, orderId);
    if (!(ADDRESS_STATUSES as readonly string[]).includes(order.status)) {
      throw new ConflictError('The delivery address can no longer be changed for this order');
    }
    if (ctx.expectedVersion !== undefined && ctx.expectedVersion !== order.version) {
      throw new ConflictError('Order was updated by someone else – reload and try again');
    }
    if (order.status === 'READY_FOR_PAYMENT') {
      await transitionOrder(orderId, 'AWAITING_ADDRESS', { ...ctx, expectedVersion: undefined, reason: 'Delivery address changed' }, tx);
      order = await getOrder(tx, orderId);
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        shipName: address.name,
        shipPhone: address.phone,
        shipHouse: address.house,
        shipStreet: address.street,
        shipLandmark: address.landmark ?? null,
        shipCity: address.city,
        shipState: address.state,
        shipPincode: address.pincode,
        version: { increment: 1 },
      },
    });
    await tx.customer.update({
      where: { id: order.customerId },
      data: { savedAddress: address as unknown as Prisma.InputJsonValue },
    });
    await recordEvent(tx, {
      ...ctx,
      orderId,
      type: 'ADDRESS_UPDATED',
      message: `Delivery address: ${address.name}, ${address.city} ${address.pincode}`,
      data: address as unknown as Prisma.InputJsonValue,
    });
  });

  await cancelJobs(prisma, orderId, ADDRESS_JOBS);
  const shipping = await onAddressCollected(orderId, ctx.actor === 'ADMIN' ? 'admin' : 'customer');
  return { address, errors: {}, shipping };
}

/**
 * Next step once an address is stored: calculate shipping with Shiprocket. If no courier
 * delivers to the pincode, a customer is asked for another address; an admin gets a warning.
 */
export async function onAddressCollected(orderId: string, source: 'customer' | 'admin'): Promise<AddressQuoteResult> {
  let result: QuoteResult;
  try {
    result = await quoteShipping(orderId, { actor: 'SYSTEM', actorRef: 'shipping' });
  } catch (err) {
    // A newer address (or an admin change) arrived while this quote was calculated. For a
    // customer the newer one wins quietly; an admin gets the conflict and reloads.
    if (err instanceof StaleQuoteError && source === 'customer') return { ok: false, reason: 'stale', message: err.message };
    throw err;
  }
  if (result.ok || result.reason !== 'unserviceable') return result;

  // Keep the rest of the address for reference but drop the pincode, so the order counts as
  // "no address yet" again (reminders, resend, timeout all resume).
  const order = await loadOrder(orderId);
  const rejected = order.shipPincode!;
  await prisma.order.update({ where: { id: orderId }, data: { shipPincode: null } });
  await scheduleResponseJobs(orderId, 'address');

  if (source === 'customer') {
    await sendAddressRequest(orderId, 'unserviceable', {
      body: copy.unserviceablePincode(rejected),
      prefill: { ...prefillFromOrder(order), inPinCode: rejected },
      validationErrors: { in_pin_code: copy.UNSERVICEABLE_FIELD_ERROR },
    });
  }
  return result;
}

function prefillFromOrder(order: Order): AddressPrefill {
  return {
    name: order.shipName ?? undefined,
    phoneNumber: order.shipPhone ?? undefined,
    houseNumber: order.shipHouse ?? undefined,
    address: order.shipStreet ?? undefined,
    landmarkArea: order.shipLandmark ?? undefined,
    city: order.shipCity ?? undefined,
    state: order.shipState ?? undefined,
  };
}

/** Admin enters or corrects the address. Returns a warning when shipping could not be calculated. */
export async function saveAddressByAdmin(orderId: string, fields: AddressFields, adminId: string, expectedVersion: number) {
  const { errors, shipping } = await saveAddress(orderId, fields, { actor: 'ADMIN', actorRef: adminId, expectedVersion });
  if (Object.keys(errors).length > 0) throw new ValidationError(Object.values(errors).join('. '), { errors });
  if (shipping && !shipping.ok) {
    return {
      warning:
        shipping.reason === 'unserviceable'
          ? `Address saved, but ${shipping.message.toLowerCase()}. Enter a different pincode.`
          : `Address saved. ${shipping.message} – use “Calculate shipping” to try again.`,
    };
  }
  return {};
}

// ─────────────────────────────────────────────────────────────
// Inbound customer messages
// ─────────────────────────────────────────────────────────────

const reply = (customer: Customer, orderId: string | undefined, body: string) =>
  sendToCustomer({ customer, orderId, message: { kind: 'text', body } });

/** Customer tapped one of our buttons (interactive reply or template quick reply). */
export async function handleButtonReply(customer: Customer, message: InboundMessage): Promise<void> {
  const parsed = message.reply ? parseButtonId(message.reply.id) : null;
  if (!parsed) {
    logger.info({ id: message.reply?.id }, 'ignoring unknown button reply');
    return;
  }
  const order = await prisma.order.findUnique({ where: { id: parsed.orderId } });
  if (!order || order.customerId !== customer.id) {
    logger.warn({ orderId: parsed.orderId, from: customer.waId }, 'button reply for an order of another customer');
    return;
  }

  await recordEvent(prisma, {
    actor: 'CUSTOMER',
    actorRef: customer.waId,
    orderId: order.id,
    type: 'MESSAGE_RECEIVED',
    message: `Tapped “${message.reply?.title}”`,
  });

  const ctx: ActorContext = { actor: 'CUSTOMER', actorRef: customer.waId };

  if (parsed.action === 'address') {
    if (order.status === 'AWAITING_ADDRESS') await sendAddressRequest(order.id, 'accepted');
    else if (order.status === 'CANCELLED') await reply(customer, order.id, copy.alreadyCancelled());
    return;
  }
  if (parsed.action === 'pay') {
    // Template "Review & Pay" tapped – the window is open now, so the native Pay Now can be sent.
    if (order.status === 'PAYMENT_REQUESTED') await sendPaymentMessage(order.id, 'request');
    else if (order.status === 'CANCELLED') await reply(customer, order.id, copy.alreadyCancelled());
    else await reply(customer, order.id, copy.alreadyConfirmed());
    return;
  }

  if (order.status === 'CANCELLED') return void (await reply(customer, order.id, copy.alreadyCancelled()));
  if (order.status !== 'AWAITING_CUSTOMER_APPROVAL') {
    // Accepting twice, or tapping after the admin reopened the order for edits.
    const text = ['MODIFIED', 'PENDING_REVIEW'].includes(order.status) ? copy.outdatedVersion() : copy.alreadyConfirmed();
    return void (await reply(customer, order.id, text));
  }
  if (parsed.round !== order.approvalRound) {
    await reply(customer, order.id, copy.outdatedVersion());
    await sendRevisionForApproval(order.id);
    return;
  }

  // Both answers are pinned to the version whose round was just checked: if the admin changed the
  // order in between, this fails and the redelivered tap is answered against the new state.
  if (parsed.action === 'accept') {
    await transitionOrder(order.id, 'AWAITING_ADDRESS', { ...ctx, reason: 'Customer accepted the revised order', expectedVersion: order.version });
    await cancelJobs(prisma, order.id, APPROVAL_JOBS);
    await scheduleResponseJobs(order.id, 'address'); // before sending, so a failed send still times out
    await sendAddressRequest(order.id, 'accepted');
  } else {
    await cancelOrder(order.id, { ...ctx, expectedVersion: order.version }, 'Customer declined the revised order', 'customer');
  }
}

/**
 * The order an address form reply belongs to. WhatsApp links the reply to the address request it
 * answers (context message id), and every request we send is stored with its order – so a customer
 * with two orders gets the address on the right one. Without that link: the order still waiting for
 * an address, else the one in final review.
 */
async function orderForAddressReply(customerId: string, contextMessageId: string | undefined) {
  if (contextMessageId) {
    const request = await prisma.message.findUnique({ where: { waMessageId: contextMessageId } });
    if (request?.orderId) {
      const order = await prisma.order.findUnique({ where: { id: request.orderId } });
      if (order && order.customerId === customerId && (ADDRESS_STATUSES as readonly string[]).includes(order.status)) return order;
    }
  }
  return (
    (await prisma.order.findFirst({ where: { customerId, status: 'AWAITING_ADDRESS' }, orderBy: { updatedAt: 'desc' } })) ??
    (await prisma.order.findFirst({ where: { customerId, status: 'READY_FOR_PAYMENT' }, orderBy: { updatedAt: 'desc' } }))
  );
}

/** Customer submitted the native WhatsApp address form. */
export async function handleAddressReply(customer: Customer, message: InboundMessage): Promise<void> {
  const order = await orderForAddressReply(customer.id, message.contextMessageId);
  if (!order) {
    await reply(customer, undefined, copy.noOrderAwaitingAddress());
    return;
  }
  const fields = fromWhatsAppAddress(message.address ?? {});
  const { address, errors, shipping } = await saveAddress(order.id, fields, { actor: 'CUSTOMER', actorRef: customer.waId });

  if (!address) {
    await recordEvent(prisma, {
      actor: 'CUSTOMER',
      actorRef: customer.waId,
      orderId: order.id,
      type: 'MESSAGE_RECEIVED',
      message: `Address form incomplete: ${Object.values(errors).join('; ')}`,
    });
    const p = message.address ?? {};
    await sendAddressRequest(order.id, 'retry', {
      prefill: {
        name: p.name,
        phoneNumber: p.phoneNumber,
        inPinCode: p.pincode,
        houseNumber: p.houseNumber,
        floorNumber: p.floorNumber,
        towerNumber: p.towerNumber,
        buildingName: p.buildingName,
        address: p.address,
        landmarkArea: p.landmarkArea,
        city: p.city,
        state: p.state,
      },
      validationErrors: errors,
    });
    return;
  }
  // Unserviceable pincode: the customer has already been asked for another address.
  // Stale: a newer address form from the customer overtook this one and is being handled.
  if (shipping && !shipping.ok && (shipping.reason === 'unserviceable' || shipping.reason === 'stale')) return;
  await reply(customer, order.id, copy.addressSaved(address));
}

/** Free text from the customer: logged on their open order; nudged towards the form when we need an address. */
export async function handleText(customer: Customer, message: InboundMessage): Promise<void> {
  // An open order first; otherwise a recently closed one, so replies to the feedback message
  // (sent when the order completes) still land in that order's history.
  const open =
    (await prisma.order.findFirst({
      where: { customerId: customer.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      orderBy: { updatedAt: 'desc' },
    })) ??
    (await prisma.order.findFirst({
      where: { customerId: customer.id, updatedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
      orderBy: { updatedAt: 'desc' },
    }));
  if (!open) return;

  await prisma.message.update({ where: { waMessageId: message.id }, data: { orderId: open.id } });
  await recordEvent(prisma, {
    actor: 'CUSTOMER',
    actorRef: customer.waId,
    orderId: open.id,
    type: 'MESSAGE_RECEIVED',
    message: `“${(message.text ?? '').slice(0, 500)}”`,
  });

  if (open.status === 'AWAITING_ADDRESS' && !open.shipPincode) {
    await sendAddressRequest(open.id, 'nudge');
  }
}
