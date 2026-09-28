import type { OrderStatus } from './types';

export function inr(paise: number): string {
  const rupees = paise / 100;
  const digits = Number.isInteger(rupees) ? 0 : 2;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "649" / "649.50" → paise. Returns null for anything that is not a valid non-negative amount. */
export function parseRupees(value: string): number | null {
  const cleaned = value.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function rupeesInput(paise: number): string {
  return (paise / 100).toFixed(Number.isInteger(paise / 100) ? 0 : 2);
}

const dateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

export function when(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** +91 98765 43210 */
export function phone(waId: string): string {
  const m = /^91(\d{5})(\d{5})$/.exec(waId);
  return m ? `+91 ${m[1]} ${m[2]}` : `+${waId}`;
}

export const STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'New',
  PENDING_REVIEW: 'Pending review',
  MODIFIED: 'Modified',
  AWAITING_CUSTOMER_APPROVAL: 'Customer approval',
  AWAITING_ADDRESS: 'Awaiting address',
  READY_FOR_PAYMENT: 'Ready for payment',
  PAYMENT_REQUESTED: 'Waiting for payment',
  PAID: 'Paid',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export type StatusTone = 'review' | 'attention' | 'waiting' | 'paid' | 'shipping' | 'done' | 'closed';

export const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  NEW: 'review',
  PENDING_REVIEW: 'review',
  MODIFIED: 'attention',
  AWAITING_CUSTOMER_APPROVAL: 'attention',
  AWAITING_ADDRESS: 'waiting',
  READY_FOR_PAYMENT: 'waiting',
  PAYMENT_REQUESTED: 'waiting',
  PAID: 'paid',
  PROCESSING: 'paid',
  SHIPPED: 'shipping',
  IN_TRANSIT: 'shipping',
  OUT_FOR_DELIVERY: 'shipping',
  DELIVERED: 'done',
  COMPLETED: 'done',
  CANCELLED: 'closed',
};
