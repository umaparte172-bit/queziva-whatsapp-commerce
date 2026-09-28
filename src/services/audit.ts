import type { Actor, OrderEventType, OrderStatus, Prisma } from '@prisma/client';
import type { Db } from '../lib/prisma.js';

export interface ActorContext {
  actor: Actor;
  /** Admin user id, customer WhatsApp id, or job/webhook name */
  actorRef?: string;
}

export interface EventInput extends ActorContext {
  orderId: string;
  type: OrderEventType;
  message?: string;
  fromStatus?: OrderStatus;
  toStatus?: OrderStatus;
  data?: Prisma.InputJsonValue;
}

/** Appends an entry to the order's audit trail. Events are never updated or deleted. */
export function recordEvent(db: Db, input: EventInput) {
  return db.orderEvent.create({
    data: {
      orderId: input.orderId,
      type: input.type,
      actor: input.actor,
      actorRef: input.actorRef,
      message: input.message,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      data: input.data,
    },
  });
}

export function listEvents(db: Db, orderId: string) {
  return db.orderEvent.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}
