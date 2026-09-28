import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  canTransition,
  isEditable,
  isTerminal,
  ORDER_STATUSES,
  TRANSITIONS,
} from '../src/domain/orderStatus.js';

describe('order state machine', () => {
  it('defines transitions for every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('only allows a payment request from READY_FOR_PAYMENT', () => {
    const into = ORDER_STATUSES.filter((from) =>
      (['ADMIN', 'SYSTEM', 'CUSTOMER'] as const).some((a) => canTransition(from, 'PAYMENT_REQUESTED', a)),
    );
    expect(into).toEqual(['READY_FOR_PAYMENT']);
  });

  it('only lets the system (after verification) mark an order PAID', () => {
    expect(canTransition('PAYMENT_REQUESTED', 'PAID', 'SYSTEM')).toBe(true);
    expect(canTransition('PAYMENT_REQUESTED', 'PAID', 'ADMIN')).toBe(false);
    expect(canTransition('PAYMENT_REQUESTED', 'PAID', 'CUSTOMER')).toBe(false);
  });

  it('requires the customer (not admin) to accept a modified order', () => {
    expect(canTransition('AWAITING_CUSTOMER_APPROVAL', 'AWAITING_ADDRESS', 'CUSTOMER')).toBe(true);
    expect(canTransition('AWAITING_CUSTOMER_APPROVAL', 'AWAITING_ADDRESS', 'ADMIN')).toBe(false);
    expect(canTransition('MODIFIED', 'AWAITING_ADDRESS', 'ADMIN')).toBe(false);
  });

  it('never skips address collection on the way to payment', () => {
    for (const from of ['NEW', 'PENDING_REVIEW', 'MODIFIED', 'AWAITING_CUSTOMER_APPROVAL'] as const) {
      expect(canTransition(from, 'READY_FOR_PAYMENT', 'ADMIN')).toBe(false);
      expect(canTransition(from, 'READY_FOR_PAYMENT', 'SYSTEM')).toBe(false);
    }
  });

  it('lets only admin cancel once paid – after dispatch only to close a returned or lost parcel', () => {
    expect(canTransition('PAID', 'CANCELLED', 'ADMIN')).toBe(true);
    expect(canTransition('PAID', 'CANCELLED', 'CUSTOMER')).toBe(false);
    expect(canTransition('PAID', 'CANCELLED', 'SYSTEM')).toBe(false);
    expect(canTransition('SHIPPED', 'CANCELLED', 'ADMIN')).toBe(true);
    expect(canTransition('IN_TRANSIT', 'CANCELLED', 'SYSTEM')).toBe(false);
    expect(canTransition('DELIVERED', 'CANCELLED', 'ADMIN')).toBe(false);
  });

  it('treats COMPLETED and CANCELLED as terminal', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('DELIVERED')).toBe(false);
  });

  it('allows item edits only before approval', () => {
    expect(isEditable('PENDING_REVIEW')).toBe(true);
    expect(isEditable('AWAITING_CUSTOMER_APPROVAL')).toBe(true);
    expect(isEditable('AWAITING_ADDRESS')).toBe(false);
    expect(isEditable('PAID')).toBe(false);
  });

  it('lists allowed next steps per actor', () => {
    expect(allowedTransitions('AWAITING_CUSTOMER_APPROVAL', 'CUSTOMER').sort()).toEqual(
      ['AWAITING_ADDRESS', 'CANCELLED'].sort(),
    );
  });
});
