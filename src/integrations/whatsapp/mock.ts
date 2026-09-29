import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { safeEqual, verifyHmacSha256 } from '../../lib/signature.js';
import type {
  AddressPrefill,
  ButtonMessage,
  CtaUrlMessage,
  ImageMessage,
  OrderDetailsMessage,
  OrderStatusMessage,
  SendResult,
  TemplateMessage,
  WhatsAppClient,
} from './types.js';
import { validateButtons, validateCtaUrl, validateImage, validateInteractiveBody, validateOrderDetails, validateText } from './validate.js';

export const MOCK_WHATSAPP_APP_SECRET = 'mock_whatsapp_app_secret';
export const MOCK_WHATSAPP_VERIFY_TOKEN = 'mock_whatsapp_verify_token';

export interface MockSentMessage {
  messageId: string;
  to: string;
  kind: 'text' | 'image' | 'buttons' | 'cta_url' | 'template' | 'address' | 'order_details' | 'order_status';
  content: unknown;
  sentAt: Date;
}

/**
 * Stand-in for the WhatsApp Cloud API. Applies the same validation as the live client,
 * then keeps messages in memory (for tests and the chat simulator) instead of sending them.
 */
export class MockWhatsAppClient implements WhatsAppClient {
  readonly mode = 'mock' as const;
  readonly sent: MockSentMessage[] = [];
  readonly readReceipts: string[] = [];

  private record(to: string, kind: MockSentMessage['kind'], content: unknown): SendResult {
    const messageId = `wamid.MOCK_${randomUUID()}`;
    this.sent.push({ messageId, to, kind, content, sentAt: new Date() });
    logger.debug({ to, kind, messageId }, '[mock whatsapp] message sent');
    return { messageId };
  }

  async sendText(to: string, body: string) {
    validateText(body);
    return this.record(to, 'text', { body });
  }

  async sendImage(to: string, message: ImageMessage) {
    validateImage(message);
    return this.record(to, 'image', message);
  }

  async sendButtons(to: string, message: ButtonMessage) {
    validateButtons(message);
    return this.record(to, 'buttons', message);
  }

  async sendCtaUrl(to: string, message: CtaUrlMessage) {
    validateCtaUrl(message);
    return this.record(to, 'cta_url', message);
  }

  async sendTemplate(to: string, template: TemplateMessage) {
    return this.record(to, 'template', template);
  }

  async sendAddressRequest(to: string, body: string, prefill?: AddressPrefill, validationErrors?: Record<string, string>) {
    validateInteractiveBody(body);
    return this.record(to, 'address', { body, prefill, validationErrors });
  }

  async sendOrderDetails(to: string, order: OrderDetailsMessage) {
    validateOrderDetails(order);
    return this.record(to, 'order_details', order);
  }

  async sendOrderStatus(to: string, status: OrderStatusMessage) {
    validateInteractiveBody(status.body);
    return this.record(to, 'order_status', status);
  }

  async markRead(messageId: string) {
    this.readReceipts.push(messageId);
  }

  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined) {
    const signature = signatureHeader?.startsWith('sha256=') ? signatureHeader.slice(7) : '';
    return verifyHmacSha256(MOCK_WHATSAPP_APP_SECRET, rawBody, signature);
  }

  verifySubscriptionToken(token: string | undefined) {
    return safeEqual(token, MOCK_WHATSAPP_VERIFY_TOKEN);
  }

  lastTo(to: string): MockSentMessage | undefined {
    return this.sent.filter((m) => m.to === to).at(-1);
  }

  reset() {
    this.sent.length = 0;
    this.readReceipts.length = 0;
  }
}
