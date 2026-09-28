import type { OrderItem } from '@prisma/client';
import { env } from '../config/env.js';
import { formatAddress, type DeliveryAddress } from '../domain/address.js';
import { formatINR } from '../lib/money.js';

/**
 * Customer-facing WhatsApp copy. Kept in one place so the wording can be reviewed and
 * changed without touching the workflow code.
 */

type Line = Pick<OrderItem, 'name' | 'quantity' | 'unitPricePaise'>;
type ItemState = Pick<OrderItem, 'id' | 'name' | 'quantity' | 'requestedQuantity' | 'unitPricePaise' | 'removed' | 'addedByAdmin' | 'replacesItemId'>;

const brand = () => env.BRAND_NAME;

export function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || 'there';
}

export function itemLines(items: Line[], max = 15): string {
  const shown = items.slice(0, max).map((i) => `• ${i.name} × ${i.quantity} — ${formatINR(i.unitPricePaise * i.quantity)}`);
  if (items.length > max) shown.push(`…and ${items.length - max} more`);
  return shown.join('\n');
}

export function orderReceived(order: { requestNumber: string; items: Line[]; subtotalPaise: number }): string {
  return [
    `Thank you for your order request! 💎`,
    ``,
    `Request ID: ${order.requestNumber}`,
    itemLines(order.items),
    ``,
    `Items total: ${formatINR(order.subtotalPaise)}`,
    ``,
    `Our team is checking availability and will confirm your order shortly.`,
    `No payment is needed right now.`,
    ``,
    `– Team ${brand()}`,
  ].join('\n');
}

export function emptyCart(): string {
  return `We couldn't read any items in that cart. Please add products from our catalogue and send the cart again.`;
}

// ── Revised order (customer approval) ─────────────────────────

/** Plain-language list of what the admin changed compared with the customer's cart. */
export function changeLines(items: ItemState[]): string[] {
  const lines: string[] = [];
  for (const item of items.filter((i) => i.requestedQuantity > 0)) {
    if (item.removed) {
      const replacement = items.find((i) => i.replacesItemId === item.id && !i.removed);
      lines.push(
        replacement
          ? `${item.name}: replaced with ${replacement.name} × ${replacement.quantity}`
          : `${item.name}: currently unavailable, removed`,
      );
    } else if (item.quantity < item.requestedQuantity) {
      lines.push(`${item.name}: ${item.requestedQuantity} requested, only ${item.quantity} available`);
    } else if (item.quantity > item.requestedQuantity) {
      lines.push(`${item.name}: quantity changed from ${item.requestedQuantity} to ${item.quantity}`);
    }
  }
  for (const added of items.filter((i) => i.addedByAdmin && !i.replacesItemId && !i.removed && i.requestedQuantity === 0)) {
    lines.push(`${added.name} × ${added.quantity} added`);
  }
  return lines;
}

export const REVISED_ORDER_HEADER = () => `Order Update – ${brand()}`;

export function revisedOrder(o: { customerName: string | null; requestNumber: string; items: ItemState[]; subtotalPaise: number; discountPaise: number }): string {
  const active = o.items.filter((i) => !i.removed && i.quantity > 0);
  const build = (maxItems: number) =>
    [
      `Hi ${firstName(o.customerName)}, we've reviewed your order ${o.requestNumber}.`,
      ``,
      `What changed:`,
      ...changeLines(o.items).map((l) => `• ${l}`),
      ``,
      `Updated order:`,
      itemLines(active, maxItems),
      ``,
      `Updated product total: ${formatINR(o.subtotalPaise)}`,
      ...(o.discountPaise ? [`Discount: −${formatINR(o.discountPaise)}`] : []),
      `Shipping will be added once you share your delivery address.`,
      ``,
      `Please confirm below. No payment is needed yet.`,
    ].join('\n');
  // Interactive message bodies are limited to 1024 characters.
  let text = build(15);
  for (let max = 10; text.length > 1024 && max >= 3; max -= 3) text = build(max);
  return text.slice(0, 1024);
}

export function revisedOrderTemplateValues(o: { customerName: string | null; requestNumber: string; items: ItemState[]; subtotalPaise: number }): string[] {
  return [firstName(o.customerName), o.requestNumber, changeLines(o.items).join('; ') || 'Items updated', formatINR(o.subtotalPaise)];
}

export const BUTTON_ACCEPT = 'Accept Updated Order';
export const BUTTON_CANCEL = 'Cancel Order';

export function approvalReminder(requestNumber: string): string {
  return `Just a reminder – your updated order ${requestNumber} is waiting for your confirmation. Please accept or cancel it below.`;
}

// ── Address ───────────────────────────────────────────────────

export function addressRequest(o: { customerName: string | null; requestNumber: string }, reason: 'approved' | 'accepted' | 'reminder' | 'retry' | 'nudge'): string {
  switch (reason) {
    case 'approved':
      return `Great news, ${firstName(o.customerName)}! Your order ${o.requestNumber} is confirmed ✨\n\nPlease share your delivery address using the form below so we can calculate shipping.`;
    case 'accepted':
      return `Thank you for confirming your order ${o.requestNumber}! 💎\n\nPlease share your delivery address using the form below so we can calculate shipping.`;
    case 'reminder':
      return `Just a reminder – we still need your delivery address for order ${o.requestNumber}. Tap below to share it.`;
    case 'retry':
      return `A few details need a quick fix. Please check the highlighted fields and send the form again.`;
    case 'nudge':
      return `To make sure your parcel reaches you, please share your address using the form below 👇`;
  }
}

export function addressTemplateValues(o: { customerName: string | null; requestNumber: string }): string[] {
  return [firstName(o.customerName), o.requestNumber];
}

export function addressSaved(address: DeliveryAddress): string {
  return `Thank you! We've saved your delivery address:\n\n${formatAddress(address)}\n\nWe're calculating shipping and will send your final amount shortly.`;
}

export function unserviceablePincode(pincode: string): string {
  return `Sorry – our couriers don't deliver to pincode ${pincode} yet. Please share a different delivery address (for example your office or a family member's home).`;
}

export const UNSERVICEABLE_FIELD_ERROR = 'We cannot deliver to this pincode yet';

export function noOrderAwaitingAddress(): string {
  return `Thanks! We don't have an order waiting for an address right now. If you'd like to order, just browse our catalogue and send your cart. 💎`;
}

// ── Cancellation & outdated buttons ───────────────────────────

export function cancelledByCustomer(requestNumber: string): string {
  return `Your order ${requestNumber} has been cancelled. We'd love to help you find something else – browse our catalogue anytime. 💎`;
}

export function cancelledByStore(requestNumber: string): string {
  return `We're sorry – we had to cancel your order ${requestNumber}. No payment was taken. Reply here if you have any questions.`;
}

export function cancelledNoResponse(requestNumber: string): string {
  return `Your order ${requestNumber} has been cancelled because we didn't hear back. You're welcome to order again anytime from our catalogue.`;
}

/** Third template variable for qz_order_cancelled – a short sentence, no line breaks. */
export function cancelledTemplateReason(kind: 'store' | 'customer' | 'timeout' | 'payment_timeout'): string {
  switch (kind) {
    case 'store':
      return 'No payment was taken.';
    case 'customer':
      return 'This was done at your request.';
    case 'timeout':
      return "We didn't hear back, so the order was closed.";
    case 'payment_timeout':
      return "The payment wasn't completed in time.";
  }
}

export function cancelledPaymentTimeout(requestNumber: string): string {
  return `Your order ${requestNumber} has been cancelled because the payment wasn't completed in time. You're welcome to order again anytime from our catalogue.`;
}

// ── Payment ───────────────────────────────────────────────────

export function paymentRequest(o: { requestNumber: string }, reason: 'request' | 'reminder'): string {
  return reason === 'reminder'
    ? `Just a reminder – your order ${o.requestNumber} is waiting for payment. Review it below and pay securely on WhatsApp.`
    : `Your ${brand()} order is ready 💎\n\nRequest ID: ${o.requestNumber}\nPlease review the final amount below and pay securely on WhatsApp.`;
}

export function paymentTemplateValues(o: { customerName: string | null; requestNumber: string; totalPaise: number }): string[] {
  return [firstName(o.customerName), o.requestNumber, formatINR(o.totalPaise)];
}

export function orderConfirmed(o: { orderNumber: string; amountPaise: number }): string {
  return [
    `🎉 Payment Successful`,
    ``,
    `Order ID: ${o.orderNumber}`,
    `Amount Paid: ${formatINR(o.amountPaise)}`,
    ``,
    `Your ${brand()} order has been confirmed. We'll share your tracking details as soon as it ships.`,
  ].join('\n');
}

export function orderConfirmedTemplateValues(o: { customerName: string | null; orderNumber: string; amountPaise: number }): string[] {
  return [firstName(o.customerName), o.orderNumber, formatINR(o.amountPaise)];
}

export function paymentFailed(): string {
  return `Your payment didn't go through. If any amount was debited, your bank will reverse it automatically. You can try again from the order above, or reply here if you need help.`;
}

export function paymentWithdrawn(requestNumber: string): string {
  return `We're updating your order ${requestNumber}. Please don't pay the earlier request – a new one will follow shortly.`;
}

export function refundInitiated(o: { orderRef: string; amountPaise: number }): string {
  return `Your order ${o.orderRef} has been cancelled and a refund of ${formatINR(o.amountPaise)} has been initiated. It usually reaches your account in 5–7 working days.`;
}

/** A refund that went through on a retry, or for an order that was not delivered. */
export function refundIssued(o: { orderRef: string; amountPaise: number }): string {
  return `A refund of ${formatINR(o.amountPaise)} for your order ${o.orderRef} has been initiated. It usually reaches your account in 5–7 working days.`;
}

export function refundTemplateReason(amountPaise: number): string {
  return `A refund of ${formatINR(amountPaise)} has been initiated.`;
}

/** A payment arrived that could not be applied (order changed, cancelled or already paid). */
export function paymentAutoRefunded(amountPaise: number): string {
  return `We received your payment of ${formatINR(amountPaise)}, but that payment request was no longer valid (the order was updated, cancelled or already paid). We've started a full refund – it usually reaches you in 5–7 working days. Reply here if you have any questions.`;
}

// ── Shipping updates & follow-up ──────────────────────────────

export const TRACK_BUTTON = 'Track Shipment';

export function dispatched(o: { orderNumber: string; courier: string; awb: string }): string {
  return [
    `📦 Your ${brand()} Order Has Been Dispatched!`,
    ``,
    `Order ID: ${o.orderNumber}`,
    `Courier: ${o.courier}`,
    `AWB: ${o.awb}`,
    ``,
    `Tap below to track your shipment.`,
  ].join('\n');
}

export function inTransit(o: { orderNumber: string; location?: string | null }): string {
  return `🚚 Your order ${o.orderNumber} is on its way${o.location ? ` – last seen at ${o.location}` : ''}.`;
}

export function outForDelivery(o: { orderNumber: string }): string {
  return `🛵 Your ${brand()} order ${o.orderNumber} is out for delivery today! Please keep your phone handy for the courier.`;
}

export function deliveryAttemptFailed(o: { orderNumber: string }): string {
  return `We couldn't deliver your order ${o.orderNumber} today. The courier will try again – reply here if you'd like to share delivery instructions.`;
}

/** Client's delivered + unboxing wording. */
export function delivered(o: { orderNumber: string }): string {
  return [
    `🎉 Your ${brand()} Order Has Been Delivered!`,
    ``,
    `Order ID: ${o.orderNumber}`,
    ``,
    `We hope you love your jewellery! 💎`,
    ``,
    `📹 Please record a continuous unboxing video while opening your parcel. This helps us in case of any issue with the shipment.`,
  ].join('\n');
}

export function feedbackRequest(o: { customerName: string | null; instagramHandle: string; reviewUrl?: string }): string {
  return [
    `Hi ${firstName(o.customerName)}! 💎 How are you liking your ${brand()} jewellery?`,
    ``,
    `We'd love to hear your feedback – just reply to this message.`,
    ...(o.reviewUrl ? [``, `⭐ Leave us a review: ${o.reviewUrl}`] : []),
    ...(o.instagramHandle
      ? [``, `📸 Follow us on Instagram @${o.instagramHandle} and tag us when you wear your pieces – we love to share our customers' looks!`]
      : []),
  ].join('\n');
}

export const INSTAGRAM_BUTTON = 'Follow on Instagram';

export const alreadyCancelled = () => `This order has already been cancelled. You're welcome to place a new order from our catalogue.`;
export const alreadyConfirmed = () => `You've already confirmed this order 👍 We'll keep you posted here.`;
export const outdatedVersion = () => `This order was updated again – please use the latest message we sent you.`;
