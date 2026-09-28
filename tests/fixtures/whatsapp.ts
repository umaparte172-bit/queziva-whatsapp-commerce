import { MOCK_WHATSAPP_APP_SECRET } from '../../src/integrations/whatsapp/mock.js';
import { hmacSha256Hex } from '../../src/lib/signature.js';

/** Builders for WhatsApp Cloud API webhook payloads, matching Meta's documented shapes. */

export const PHONE_NUMBER_ID = '100000000000001';
export const WA_ID = '919876543210';

const nowTs = () => String(Math.floor(Date.now() / 1000));

function envelope(value: object) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919999999999', phone_number_id: PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

function inbound(message: object, from = WA_ID, name = 'Priya') {
  return envelope({
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, timestamp: nowTs(), ...message }],
  });
}

export function cartWebhook(
  id: string,
  items: { retailerId: string; quantity: number; price: number }[],
  opts: { from?: string; note?: string } = {},
) {
  return inbound(
    {
      id,
      type: 'order',
      order: {
        catalog_id: 'CATALOG_1',
        text: opts.note,
        product_items: items.map((i) => ({
          product_retailer_id: i.retailerId,
          quantity: i.quantity,
          item_price: i.price,
          currency: 'INR',
        })),
      },
    },
    opts.from,
  );
}

export function textWebhook(id: string, body: string, from = WA_ID) {
  return inbound({ id, type: 'text', text: { body } }, from);
}

export function buttonReplyWebhook(id: string, buttonId: string, title: string, contextId?: string) {
  return inbound({
    id,
    type: 'interactive',
    ...(contextId ? { context: { from: '919999999999', id: contextId } } : {}),
    interactive: { type: 'button_reply', button_reply: { id: buttonId, title } },
  });
}

/** Customer tapped a quick-reply button on a template message. */
export function templateButtonWebhook(id: string, payload: string, text: string, from = WA_ID) {
  return inbound({ id, type: 'button', button: { payload, text } }, from);
}

export function addressReplyWebhook(id: string, values: Record<string, string>) {
  return inbound({
    id,
    type: 'interactive',
    interactive: {
      type: 'nfm_reply',
      nfm_reply: {
        name: 'address_message',
        body: 'Address submitted',
        response_json: JSON.stringify({ saved_address_id: 'addr_1', values }),
      },
    },
  });
}

export function statusWebhook(messageId: string, status: string, errors?: object[]) {
  return envelope({
    statuses: [{ id: messageId, status, timestamp: nowTs(), recipient_id: WA_ID, ...(errors ? { errors } : {}) }],
  });
}

export function paymentWebhook(
  messageId: string,
  referenceId: string,
  status: string,
  amountPaise: number,
  pgTransactionId = 'pay_TEST123',
) {
  return envelope({
    statuses: [
      {
        id: messageId,
        status,
        type: 'payment',
        timestamp: nowTs(),
        recipient_id: WA_ID,
        payment: {
          reference_id: referenceId,
          amount: { value: amountPaise, offset: 100 },
          currency: 'INR',
          transaction: {
            id: 'txn_1',
            pg_transaction_id: pgTransactionId,
            type: 'razorpay',
            status: status === 'captured' ? 'success' : status,
            created_timestamp: Number(nowTs()),
            updated_timestamp: Number(nowTs()),
          },
        },
      },
    ],
  });
}

export function signBody(raw: string, secret = MOCK_WHATSAPP_APP_SECRET) {
  return `sha256=${hmacSha256Hex(secret, raw)}`;
}
