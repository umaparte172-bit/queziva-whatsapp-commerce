import { rupeesToPaise } from '../../lib/money.js';

/**
 * Parser for WhatsApp Cloud API webhooks (object = "whatsapp_business_account").
 * Converts Meta's nested payload into a flat list of typed events.
 */

export interface ParsedAddress {
  name?: string;
  phoneNumber?: string;
  pincode?: string;
  houseNumber?: string;
  floorNumber?: string;
  towerNumber?: string;
  buildingName?: string;
  address?: string;
  landmarkArea?: string;
  city?: string;
  state?: string;
}

export interface InboundOrderItem {
  retailerId: string;
  quantity: number;
  unitPricePaise: number;
  currency: string;
}

export interface InboundMessage {
  id: string;
  from: string;
  timestamp: Date;
  /** text | order | button_reply | list_reply | address | flow | template_button | other */
  kind: 'text' | 'order' | 'button_reply' | 'list_reply' | 'address' | 'flow' | 'template_button' | 'other';
  /** Original WhatsApp message type, e.g. "interactive", "image" */
  rawType: string;
  text?: string;
  order?: { catalogId: string; note?: string; items: InboundOrderItem[] };
  reply?: { id: string; title: string };
  address?: ParsedAddress;
  flow?: { name?: string; response: unknown };
  /** Message this one replies to (e.g. the button message) */
  contextMessageId?: string;
  raw: unknown;
}

export interface MessageStatusUpdate {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  recipientId: string;
  timestamp: Date;
  errors: { code?: number; title?: string; message?: string; details?: string }[];
}

export interface PaymentStatusUpdate {
  /** wamid of the order_details message */
  messageId: string;
  /** captured | pending | failed … as reported by WhatsApp */
  status: string;
  recipientId: string;
  referenceId: string;
  amountPaise: number | null;
  currency: string | null;
  transactionId: string | null;
  /** Razorpay payment id (pay_…) */
  pgTransactionId: string | null;
  transactionStatus: string | null;
  errorReason: string | null;
  timestamp: Date;
  raw: unknown;
}

export type WebhookEvent =
  | { kind: 'message'; phoneNumberId: string; profileName?: string; message: InboundMessage }
  | { kind: 'status'; phoneNumberId: string; status: MessageStatusUpdate }
  | { kind: 'payment'; phoneNumberId: string; payment: PaymentStatusUpdate };

// Loose shapes of the incoming JSON – every field is treated as optional.
type Json = any;

const toDate = (ts: unknown) => (ts ? new Date(Number(ts) * 1000) : new Date());
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function amountToPaise(amount: Json): number | null {
  if (!amount || typeof amount.value !== 'number') return null;
  const offset = typeof amount.offset === 'number' && amount.offset > 0 ? amount.offset : 100;
  return Math.round((amount.value * 100) / offset);
}

export function parseAddressValues(values: Json): ParsedAddress {
  const v = values ?? {};
  return {
    name: str(v.name),
    phoneNumber: str(v.phone_number),
    pincode: str(v.in_pin_code),
    houseNumber: str(v.house_number),
    floorNumber: str(v.floor_number),
    towerNumber: str(v.tower_number),
    buildingName: str(v.building_name),
    address: str(v.address),
    landmarkArea: str(v.landmark_area),
    city: str(v.city),
    state: str(v.state),
  };
}

function safeJson(text: unknown): unknown {
  if (typeof text !== 'string') return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseMessage(m: Json): InboundMessage {
  const common = {
    id: String(m.id),
    from: String(m.from),
    timestamp: toDate(m.timestamp),
    rawType: String(m.type ?? 'unknown'),
    contextMessageId: str(m.context?.id),
    raw: m,
  };

  switch (m.type) {
    case 'text':
      return { ...common, kind: 'text', text: m.text?.body ?? '' };

    case 'order':
      return {
        ...common,
        kind: 'order',
        order: {
          catalogId: String(m.order?.catalog_id ?? ''),
          note: str(m.order?.text),
          items: (m.order?.product_items ?? []).map((p: Json) => ({
            retailerId: String(p.product_retailer_id),
            quantity: Number(p.quantity),
            // WhatsApp sends item_price in rupees (e.g. 299 or 299.5)
            unitPricePaise: rupeesToPaise(Number(p.item_price ?? 0)),
            currency: String(p.currency ?? 'INR'),
          })),
        },
      };

    case 'button': // quick-reply button on a template message
      return {
        ...common,
        kind: 'template_button',
        reply: { id: String(m.button?.payload ?? ''), title: String(m.button?.text ?? '') },
      };

    case 'interactive': {
      const i = m.interactive ?? {};
      if (i.type === 'button_reply') {
        return { ...common, kind: 'button_reply', reply: { id: String(i.button_reply?.id), title: String(i.button_reply?.title ?? '') } };
      }
      if (i.type === 'list_reply') {
        return { ...common, kind: 'list_reply', reply: { id: String(i.list_reply?.id), title: String(i.list_reply?.title ?? '') } };
      }
      if (i.type === 'nfm_reply') {
        const response = safeJson(i.nfm_reply?.response_json) as Json;
        if (i.nfm_reply?.name === 'address_message') {
          return { ...common, kind: 'address', address: parseAddressValues(response?.values), flow: { name: 'address_message', response } };
        }
        return { ...common, kind: 'flow', flow: { name: str(i.nfm_reply?.name), response } };
      }
      return { ...common, kind: 'other' };
    }

    default:
      return { ...common, kind: 'other' };
  }
}

function parseStatus(s: Json, phoneNumberId: string): WebhookEvent {
  if (s.type === 'payment' || s.payment) {
    const p = s.payment ?? {};
    const t = p.transaction ?? {};
    return {
      kind: 'payment',
      phoneNumberId,
      payment: {
        messageId: String(s.id),
        status: String(s.status),
        recipientId: String(s.recipient_id ?? ''),
        referenceId: String(p.reference_id ?? ''),
        amountPaise: amountToPaise(p.amount),
        currency: str(p.currency) ?? null,
        transactionId: str(t.id) ?? null,
        pgTransactionId: str(t.pg_transaction_id) ?? null,
        transactionStatus: str(t.status) ?? null,
        errorReason: str(t.error?.reason) ?? str(t.error?.code) ?? null,
        timestamp: toDate(s.timestamp),
        raw: s,
      },
    };
  }
  return {
    kind: 'status',
    phoneNumberId,
    status: {
      messageId: String(s.id),
      status: String(s.status),
      recipientId: String(s.recipient_id ?? ''),
      timestamp: toDate(s.timestamp),
      errors: (s.errors ?? []).map((e: Json) => ({
        code: e.code,
        title: e.title,
        message: e.message,
        details: e.error_data?.details,
      })),
    },
  };
}

export function parseWebhook(body: Json): WebhookEvent[] {
  if (body?.object !== 'whatsapp_business_account') return [];
  const events: WebhookEvent[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value ?? {};
      const phoneNumberId = String(value.metadata?.phone_number_id ?? '');
      const names = new Map<string, string>(
        (value.contacts ?? []).map((c: Json) => [String(c.wa_id), c.profile?.name]),
      );

      for (const m of value.messages ?? []) {
        events.push({ kind: 'message', phoneNumberId, profileName: names.get(String(m.from)), message: parseMessage(m) });
      }
      for (const s of value.statuses ?? []) {
        events.push(parseStatus(s, phoneNumberId));
      }
    }
  }
  return events;
}
