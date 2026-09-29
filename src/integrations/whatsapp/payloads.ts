import type {
  AddressPrefill,
  ButtonMessage,
  CtaUrlMessage,
  ImageMessage,
  OrderDetailsMessage,
  OrderStatusMessage,
  TemplateMessage,
} from './types.js';

/**
 * Builders for WhatsApp Cloud API `POST /{phone-number-id}/messages` bodies.
 * Amounts use { value, offset: 100 } – i.e. paise.
 */

const base = (to: string) => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to });
const money = (paise: number) => ({ value: paise, offset: 100 });

export function textPayload(to: string, body: string) {
  return { ...base(to), type: 'text', text: { body, preview_url: /https?:\/\//.test(body) } };
}

export function imagePayload(to: string, message: ImageMessage) {
  return {
    ...base(to),
    type: 'image',
    image: { link: message.imageUrl, ...(message.caption ? { caption: message.caption } : {}) },
  };
}

export function buttonsPayload(to: string, m: ButtonMessage) {
  return {
    ...base(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(m.header ? { header: { type: 'text', text: m.header } } : {}),
      body: { text: m.body },
      ...(m.footer ? { footer: { text: m.footer } } : {}),
      action: { buttons: m.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  };
}

export function ctaUrlPayload(to: string, m: CtaUrlMessage) {
  return {
    ...base(to),
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(m.header ? { header: { type: 'text', text: m.header } } : {}),
      body: { text: m.body },
      ...(m.footer ? { footer: { text: m.footer } } : {}),
      action: { name: 'cta_url', parameters: { display_text: m.buttonText, url: m.url } },
    },
  };
}

export function templatePayload(to: string, t: TemplateMessage) {
  return {
    ...base(to),
    type: 'template',
    template: { name: t.name, language: { code: t.language }, ...(t.components ? { components: t.components } : {}) },
  };
}

const ADDRESS_FIELDS: Record<keyof AddressPrefill, string> = {
  name: 'name',
  phoneNumber: 'phone_number',
  inPinCode: 'in_pin_code',
  houseNumber: 'house_number',
  floorNumber: 'floor_number',
  towerNumber: 'tower_number',
  buildingName: 'building_name',
  address: 'address',
  landmarkArea: 'landmark_area',
  city: 'city',
  state: 'state',
};

/** India-only native address form. */
export function addressPayload(
  to: string,
  body: string,
  prefill?: AddressPrefill,
  validationErrors?: Record<string, string>,
) {
  const values: Record<string, string> = {};
  for (const [key, field] of Object.entries(ADDRESS_FIELDS) as [keyof AddressPrefill, string][]) {
    const value = prefill?.[key];
    if (value) values[field] = value;
  }
  return {
    ...base(to),
    type: 'interactive',
    interactive: {
      type: 'address_message',
      body: { text: body },
      action: {
        name: 'address_message',
        parameters: {
          country: 'IN',
          ...(Object.keys(values).length ? { values } : {}),
          ...(validationErrors && Object.keys(validationErrors).length ? { validation_errors: validationErrors } : {}),
        },
      },
    },
  };
}

export interface OrderDetailsSettings {
  /** Payment configuration name from WhatsApp Manager (linked to Razorpay) */
  paymentConfiguration: string;
  catalogId?: string;
}

/** Native "Review and Pay" message using the Razorpay payment gateway configuration. */
export function orderDetailsPayload(to: string, o: OrderDetailsMessage, settings: OrderDetailsSettings) {
  return {
    ...base(to),
    type: 'interactive',
    interactive: {
      type: 'order_details',
      ...(o.headerImageUrl ? { header: { type: 'image', image: { link: o.headerImageUrl } } } : {}),
      body: { text: o.body },
      ...(o.footer ? { footer: { text: o.footer } } : {}),
      action: {
        name: 'review_and_pay',
        parameters: {
          reference_id: o.referenceId,
          type: 'physical-goods',
          payment_settings: [
            {
              type: 'payment_gateway',
              payment_gateway: {
                type: 'razorpay',
                configuration_name: settings.paymentConfiguration,
                razorpay: {
                  receipt: o.referenceId,
                  notes: { reference_id: o.referenceId },
                },
              },
            },
          ],
          currency: 'INR',
          total_amount: money(o.totalPaise),
          order: {
            status: 'pending',
            ...(settings.catalogId ? { catalog_id: settings.catalogId } : {}),
            ...(o.expiresAt
              ? {
                  expiration: {
                    timestamp: String(Math.floor(o.expiresAt.getTime() / 1000)),
                    description: 'This payment request has expired',
                  },
                }
              : {}),
            items: o.items.map((item) => ({
              retailer_id: item.retailerId,
              name: item.name,
              amount: money(item.amountPaise),
              quantity: item.quantity,
            })),
            subtotal: money(o.subtotalPaise),
            tax: { ...money(o.taxPaise), ...(o.taxDescription ? { description: o.taxDescription } : {}) },
            shipping: {
              ...money(o.shippingPaise),
              ...(o.shippingDescription ? { description: o.shippingDescription } : {}),
            },
            ...(o.discountPaise > 0
              ? {
                  discount: {
                    ...money(o.discountPaise),
                    ...(o.discountDescription ? { description: o.discountDescription } : {}),
                  },
                }
              : {}),
          },
        },
      },
    },
  };
}

/** Updates the status shown on the customer's order card. */
export function orderStatusPayload(to: string, s: OrderStatusMessage) {
  return {
    ...base(to),
    type: 'interactive',
    interactive: {
      type: 'order_status',
      body: { text: s.body },
      action: {
        name: 'review_order',
        parameters: {
          reference_id: s.referenceId,
          order: { status: s.status, ...(s.description ? { description: s.description } : {}) },
        },
      },
    },
  };
}

export function markReadPayload(messageId: string) {
  return { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
}
