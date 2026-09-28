import type { OrderStatus } from '@prisma/client';

/**
 * Shiprocket reports dozens of courier statuses. They are grouped into the handful of steps the
 * customer and the order care about; everything unusual becomes an alert for the team.
 */
export type TrackingKind =
  | { kind: 'progress'; status: Extract<OrderStatus, 'SHIPPED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED'> }
  | { kind: 'attempt_failed' }
  | { kind: 'exception'; reason: string }
  | { kind: 'info' };

export function classifyShiprocketStatus(raw: string): TrackingKind {
  const s = raw.toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Returns and losses first – "RTO DELIVERED" must not count as delivered.
  // Reasons are stable per kind of problem (the courier's own wording is recorded separately), so
  // further scans of the same return or loss are recognised as the same problem.
  if (s.startsWith('RTO') || s.includes('RETURN')) return { kind: 'exception', reason: 'Return to origin' };
  if (/\b(LOST|DAMAGED|DESTROYED|DISPOSED)\b/.test(s)) return { kind: 'exception', reason: `Shipment ${s.toLowerCase()}` };
  if (s.includes('CANCEL')) return { kind: 'exception', reason: 'Shipment cancelled at the courier' };
  if (s.includes('PICKUP') && /(EXCEPTION|ERROR|FAILED)/.test(s)) return { kind: 'exception', reason: 'Pickup problem' };

  if (s === 'UNDELIVERED' || s.includes('DELIVERY FAILED') || s.includes('FAILED DELIVERY') || s.includes('NDR')) {
    return { kind: 'attempt_failed' };
  }
  if (s === 'DELIVERED' || s.startsWith('DELIVERED')) return { kind: 'progress', status: 'DELIVERED' };
  if (s.includes('OUT FOR DELIVERY')) return { kind: 'progress', status: 'OUT_FOR_DELIVERY' };
  if (s === 'PICKED UP' || s === 'SHIPPED') return { kind: 'progress', status: 'SHIPPED' };
  if (s.includes('IN TRANSIT') || s.includes('DESTINATION HUB') || s.includes('MISROUTED') || s.includes('DELAYED') || s.includes('REACHED')) {
    return { kind: 'progress', status: 'IN_TRANSIT' };
  }
  // PICKUP SCHEDULED, OUT FOR PICKUP, AWB ASSIGNED, MANIFEST GENERATED, …
  return { kind: 'info' };
}

/** The order statuses after payment, in delivery order. */
export const DELIVERY_PATH: readonly OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];

/**
 * Status changes needed to get from `from` to `to`. Skipped steps (e.g. a missed "picked up"
 * webhook) are filled in so the order history stays complete. Going back is only allowed from
 * out-for-delivery to in-transit (failed attempt, parcel back at the hub). Returns [] when no
 * change should be made.
 */
export function pathTo(from: OrderStatus, to: OrderStatus): OrderStatus[] {
  if (from === 'OUT_FOR_DELIVERY' && to === 'IN_TRANSIT') return ['IN_TRANSIT'];
  const a = DELIVERY_PATH.indexOf(from);
  const b = DELIVERY_PATH.indexOf(to);
  if (a < 0 || b < 0 || b <= a) return [];
  // Only the steps the state machine requires are filled in (PAID → PROCESSING → SHIPPED);
  // from SHIPPED on, the order may jump straight to a later step. Nothing that did not happen
  // (e.g. "out for delivery") is invented.
  const steps: OrderStatus[] = [];
  if (a < DELIVERY_PATH.indexOf('PROCESSING')) steps.push('PROCESSING');
  if (a < DELIVERY_PATH.indexOf('SHIPPED') && to !== 'PROCESSING') steps.push('SHIPPED');
  if (!steps.includes(to)) steps.push(to);
  return steps;
}

/**
 * Parses Shiprocket timestamps, which arrive as "23 05 2026 11:43:52", "2026-05-23 11:43:52"
 * or ISO, all in Indian time unless a zone is given.
 */
export function parseShiprocketTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  let m = /^(\d{2})[ -/](\d{2})[ -/](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+05:30`);
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+05:30`);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
