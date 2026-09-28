import { ValidationError } from '../../lib/errors.js';
import type { ButtonMessage, CtaUrlMessage, OrderDetailsMessage } from './types.js';

/** WhatsApp Cloud API limits for interactive messages. */
export const LIMITS = {
  textMessage: 4096,
  bodyText: 1024,
  headerText: 60,
  footerText: 60,
  buttonTitle: 20,
  buttonId: 256,
  maxButtons: 3,
  /** order_details payment requests must expire at least 5 minutes in the future */
  minExpirySeconds: 300,
  /** order_details: item names and the tax/shipping/discount descriptions */
  orderLineText: 60,
} as const;

function checkLength(value: string | undefined, max: number, label: string) {
  if (value !== undefined && value.length > max) {
    throw new ValidationError(`${label} exceeds ${max} characters (${value.length})`);
  }
}

export function validateButtons(message: ButtonMessage): void {
  if (!message.body.trim()) throw new ValidationError('Button message body is empty');
  checkLength(message.body, LIMITS.bodyText, 'Body text');
  checkLength(message.header, LIMITS.headerText, 'Header text');
  checkLength(message.footer, LIMITS.footerText, 'Footer text');
  if (message.buttons.length === 0 || message.buttons.length > LIMITS.maxButtons) {
    throw new ValidationError(`WhatsApp reply buttons: 1–${LIMITS.maxButtons} buttons required`);
  }
  const ids = new Set<string>();
  for (const button of message.buttons) {
    if (!button.title.trim()) throw new ValidationError('Button title is empty');
    checkLength(button.title, LIMITS.buttonTitle, `Button title "${button.title}"`);
    checkLength(button.id, LIMITS.buttonId, 'Button id');
    if (ids.has(button.id)) throw new ValidationError(`Duplicate button id ${button.id}`);
    ids.add(button.id);
  }
}

export function validateCtaUrl(message: CtaUrlMessage): void {
  validateInteractiveBody(message.body);
  checkLength(message.header, LIMITS.headerText, 'Header text');
  checkLength(message.footer, LIMITS.footerText, 'Footer text');
  if (!message.buttonText.trim()) throw new ValidationError('Button text is empty');
  checkLength(message.buttonText, LIMITS.buttonTitle, 'Button text');
  if (!/^https:\/\/\S+$/.test(message.url)) throw new ValidationError(`Link must be an https:// URL, got "${message.url}"`);
}

export function validateText(body: string): void {
  if (!body.trim()) throw new ValidationError('Message text is empty');
  checkLength(body, LIMITS.textMessage, 'Text message');
}

export function validateInteractiveBody(body: string): void {
  if (!body.trim()) throw new ValidationError('Message body is empty');
  checkLength(body, LIMITS.bodyText, 'Body text');
}

/**
 * Meta rejects an order_details message unless the amounts reconcile exactly:
 *   subtotal = Σ item amount × quantity
 *   total    = subtotal + tax + shipping − discount
 */
export function validateOrderDetails(order: OrderDetailsMessage, now = new Date()): void {
  validateInteractiveBody(order.body);
  checkLength(order.footer, LIMITS.footerText, 'Footer text');
  if (!order.referenceId || order.referenceId.length > 35 || !/^[A-Za-z0-9_\-.]+$/.test(order.referenceId)) {
    throw new ValidationError(`Invalid reference_id "${order.referenceId}" (1–35 characters: letters, digits, _ - .)`);
  }
  checkLength(order.taxDescription, LIMITS.orderLineText, 'Tax description');
  checkLength(order.shippingDescription, LIMITS.orderLineText, 'Shipping description');
  checkLength(order.discountDescription, LIMITS.orderLineText, 'Discount description');
  if (order.items.length === 0) throw new ValidationError('order_details needs at least one item');

  const amounts = [order.subtotalPaise, order.discountPaise, order.shippingPaise, order.taxPaise, order.totalPaise];
  if (amounts.some((a) => !Number.isInteger(a) || a < 0)) {
    throw new ValidationError('order_details amounts must be non-negative integers (paise)');
  }

  let itemsTotal = 0;
  for (const item of order.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ValidationError(`Item ${item.retailerId} must have quantity ≥ 1`);
    }
    checkLength(item.name, LIMITS.orderLineText, `Item name "${item.name}"`);
    if (!Number.isInteger(item.amountPaise) || item.amountPaise < 0) {
      throw new ValidationError(`Item ${item.retailerId} has an invalid amount`);
    }
    itemsTotal += item.amountPaise * item.quantity;
  }
  if (itemsTotal !== order.subtotalPaise) {
    throw new ValidationError(`Subtotal ${order.subtotalPaise} does not equal the item total ${itemsTotal}`);
  }
  const expected = order.subtotalPaise + order.taxPaise + order.shippingPaise - order.discountPaise;
  if (expected !== order.totalPaise) {
    throw new ValidationError(
      `Total ${order.totalPaise} does not equal subtotal + tax + shipping − discount (${expected})`,
    );
  }
  if (order.totalPaise <= 0) throw new ValidationError('order_details total must be greater than zero');

  if (order.expiresAt && order.expiresAt.getTime() - now.getTime() < LIMITS.minExpirySeconds * 1000) {
    throw new ValidationError('Payment expiry must be at least 5 minutes in the future');
  }
}
