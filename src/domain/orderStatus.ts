import type { Actor, OrderStatus } from '@prisma/client';

/**
 * Order lifecycle
 *
 *   NEW ─► PENDING_REVIEW ─┬─► (approved as-is) ──────────────────────────┐
 *                          └─► MODIFIED ─► AWAITING_CUSTOMER_APPROVAL ─────┤ (customer accepts)
 *                                                                          ▼
 *   AWAITING_ADDRESS ─► READY_FOR_PAYMENT ─► PAYMENT_REQUESTED ─► PAID ─► PROCESSING
 *   ─► SHIPPED ─► IN_TRANSIT ─► OUT_FOR_DELIVERY ─► DELIVERED ─► COMPLETED
 *
 *   Any pre-payment state can be CANCELLED by admin, customer or system (timeouts).
 *   PAID / PROCESSING can only be cancelled by admin (refund required); after dispatch only an
 *   admin can close an order whose parcel was returned or lost.
 */

export const ORDER_STATUSES = [
  'NEW',
  'PENDING_REVIEW',
  'MODIFIED',
  'AWAITING_CUSTOMER_APPROVAL',
  'AWAITING_ADDRESS',
  'READY_FOR_PAYMENT',
  'PAYMENT_REQUESTED',
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
] as const satisfies readonly OrderStatus[];

const A = 'ADMIN' as const;
const C = 'CUSTOMER' as const;
const S = 'SYSTEM' as const;
const ANYONE = [A, C, S];

type TransitionTable = { [From in OrderStatus]: Partial<Record<OrderStatus, readonly Actor[]>> };

/** Who may move an order from one status to another. Anything not listed is forbidden. */
export const TRANSITIONS: TransitionTable = {
  NEW: {
    PENDING_REVIEW: [A, S],
    MODIFIED: [A],
    AWAITING_ADDRESS: [A],
    CANCELLED: ANYONE,
  },
  PENDING_REVIEW: {
    MODIFIED: [A],
    AWAITING_ADDRESS: [A],
    CANCELLED: ANYONE,
  },
  MODIFIED: {
    AWAITING_CUSTOMER_APPROVAL: [A],
    PENDING_REVIEW: [A, S], // edits undone – order matches the customer's request again
    CANCELLED: ANYONE,
  },
  AWAITING_CUSTOMER_APPROVAL: {
    AWAITING_ADDRESS: [C],
    MODIFIED: [A], // admin revises again before the customer answers
    CANCELLED: ANYONE, // customer declines, admin cancels, or approval timeout
  },
  AWAITING_ADDRESS: {
    READY_FOR_PAYMENT: [S, A],
    CANCELLED: ANYONE,
  },
  READY_FOR_PAYMENT: {
    PAYMENT_REQUESTED: [A, S],
    AWAITING_ADDRESS: [A, C], // address correction → shipping must be recalculated
    CANCELLED: ANYONE,
  },
  PAYMENT_REQUESTED: {
    PAID: [S], // only after server-side Razorpay verification
    READY_FOR_PAYMENT: [A], // withdraw payment request to revise amount
    AWAITING_ADDRESS: [C], // customer wants to change address before paying
    CANCELLED: ANYONE, // includes payment-expiry timeout
  },
  PAID: {
    PROCESSING: [S, A],
    CANCELLED: [A],
  },
  PROCESSING: {
    SHIPPED: [S, A],
    CANCELLED: [A],
  },
  // After dispatch an order is only closed by an admin, when the parcel comes back or is lost.
  SHIPPED: {
    IN_TRANSIT: [S, A],
    OUT_FOR_DELIVERY: [S, A],
    DELIVERED: [S, A],
    CANCELLED: [A],
  },
  IN_TRANSIT: {
    OUT_FOR_DELIVERY: [S, A],
    DELIVERED: [S, A],
    CANCELLED: [A],
  },
  OUT_FOR_DELIVERY: {
    IN_TRANSIT: [S, A], // failed delivery attempt, back in transit
    DELIVERED: [S, A],
    CANCELLED: [A],
  },
  DELIVERED: {
    COMPLETED: [S, A],
  },
  COMPLETED: {},
  CANCELLED: {},
};

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

export function allowedTransitions(from: OrderStatus, actor: Actor): OrderStatus[] {
  return (Object.entries(TRANSITIONS[from]) as [OrderStatus, readonly Actor[]][])
    .filter(([, actors]) => actors.includes(actor))
    .map(([to]) => to);
}

export function isTerminal(status: OrderStatus): boolean {
  return Object.keys(TRANSITIONS[status]).length === 0;
}

/** Items, quantities and discount may only be changed before the customer is asked to pay. */
export const EDITABLE_STATUSES: readonly OrderStatus[] = [
  'NEW',
  'PENDING_REVIEW',
  'MODIFIED',
  'AWAITING_CUSTOMER_APPROVAL',
];

export function isEditable(status: OrderStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/** Statuses at or after successful payment. */
export const PAID_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'COMPLETED',
];

export function isPaid(status: OrderStatus): boolean {
  return PAID_STATUSES.includes(status);
}

/** Order timestamp column stamped when an order enters a status. */
export const STATUS_TIMESTAMP: Partial<Record<OrderStatus, string>> = {
  PENDING_REVIEW: 'reviewStartedAt',
  AWAITING_ADDRESS: 'approvedAt',
  PAYMENT_REQUESTED: 'paymentRequestedAt',
  PAID: 'paidAt',
  PROCESSING: 'processingAt',
  SHIPPED: 'shippedAt',
  DELIVERED: 'deliveredAt',
  COMPLETED: 'completedAt',
  CANCELLED: 'cancelledAt',
};

/** Labels for the admin dashboard. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'New Order',
  PENDING_REVIEW: 'Pending Review',
  MODIFIED: 'Modified',
  AWAITING_CUSTOMER_APPROVAL: 'Customer Approval',
  AWAITING_ADDRESS: 'Awaiting Address',
  READY_FOR_PAYMENT: 'Ready for Payment',
  PAYMENT_REQUESTED: 'Waiting for Payment',
  PAID: 'Paid',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In Transit',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
