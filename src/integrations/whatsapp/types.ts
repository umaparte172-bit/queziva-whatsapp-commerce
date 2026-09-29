export interface SendResult {
  /** WhatsApp message id (wamid.…) */
  messageId: string;
}

/** Interactive reply button – WhatsApp allows up to 3, title ≤ 20 characters. */
export interface ReplyButton {
  id: string;
  title: string;
}

export interface ButtonMessage {
  body: string;
  buttons: ReplyButton[];
  header?: string;
  footer?: string;
}

/** Interactive message with a single link button (e.g. "Track Shipment"). */
export interface CtaUrlMessage {
  body: string;
  /** Button label, ≤ 20 characters */
  buttonText: string;
  url: string;
  header?: string;
  footer?: string;
}

/** Publicly accessible product image with optional customer-facing caption. */
export interface ImageMessage {
  imageUrl: string;
  caption?: string;
}

export interface TemplateMessage {
  name: string;
  language: string;
  /** Raw template components (header/body/button parameters) as per the Cloud API */
  components?: unknown[];
}

export interface AddressPrefill {
  name?: string;
  phoneNumber?: string;
  inPinCode?: string;
  houseNumber?: string;
  floorNumber?: string;
  towerNumber?: string;
  buildingName?: string;
  address?: string;
  landmarkArea?: string;
  city?: string;
  state?: string;
}

export interface OrderDetailsItem {
  retailerId: string;
  name: string;
  /** Unit price in paise */
  amountPaise: number;
  quantity: number;
}

/** Native WhatsApp order_details message with Pay Now (India payments). */
export interface OrderDetailsMessage {
  /** Unique per payment request; echoed back in the payment webhook */
  referenceId: string;
  body: string;
  footer?: string;
  headerImageUrl?: string;
  items: OrderDetailsItem[];
  subtotalPaise: number;
  discountPaise: number;
  discountDescription?: string;
  shippingPaise: number;
  shippingDescription?: string;
  taxPaise: number;
  taxDescription?: string;
  totalPaise: number;
  /** Payment request expiry (WhatsApp requires ≥ 300 seconds in the future) */
  expiresAt?: Date;
}

export type OrderStatusValue = 'pending' | 'processing' | 'partially_shipped' | 'shipped' | 'completed' | 'canceled';

/** order_status message – updates the order card the customer sees in WhatsApp. */
export interface OrderStatusMessage {
  referenceId: string;
  status: OrderStatusValue;
  body: string;
  description?: string;
}

export interface WhatsAppClient {
  readonly mode: 'mock' | 'live';
  sendText(to: string, body: string): Promise<SendResult>;
  sendImage(to: string, message: ImageMessage): Promise<SendResult>;
  sendButtons(to: string, message: ButtonMessage): Promise<SendResult>;
  sendCtaUrl(to: string, message: CtaUrlMessage): Promise<SendResult>;
  sendTemplate(to: string, template: TemplateMessage): Promise<SendResult>;
  /**
   * Native India address_message – customer fills a form inside WhatsApp.
   * validationErrors (keyed by form field, e.g. in_pin_code) re-shows the form with the problems marked.
   */
  sendAddressRequest(to: string, body: string, prefill?: AddressPrefill, validationErrors?: Record<string, string>): Promise<SendResult>;
  sendOrderDetails(to: string, order: OrderDetailsMessage): Promise<SendResult>;
  sendOrderStatus(to: string, status: OrderStatusMessage): Promise<SendResult>;
  markRead(messageId: string): Promise<void>;
  /** Checks the X-Hub-Signature-256 header ("sha256=<hex>") against the raw webhook body */
  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean;
  /** Checks hub.verify_token during Meta's webhook subscription handshake */
  verifySubscriptionToken(token: string | undefined): boolean;
}
