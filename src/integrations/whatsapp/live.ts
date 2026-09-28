import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { safeEqual, verifyHmacSha256 } from '../../lib/signature.js';
import {
  addressPayload,
  buttonsPayload,
  ctaUrlPayload,
  markReadPayload,
  orderDetailsPayload,
  orderStatusPayload,
  templatePayload,
  textPayload,
} from './payloads.js';
import type {
  AddressPrefill,
  ButtonMessage,
  CtaUrlMessage,
  OrderDetailsMessage,
  OrderStatusMessage,
  SendResult,
  TemplateMessage,
  WhatsAppClient,
} from './types.js';
import { validateButtons, validateCtaUrl, validateInteractiveBody, validateOrderDetails, validateText } from './validate.js';

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_data?: { details?: string };
}

/** Meta error codes worth explaining to the admin in plain language. */
const KNOWN_ERRORS: Record<number, string> = {
  131047: 'More than 24 hours since the customer last messaged – a template message is required',
  131026: 'Message undeliverable – the number may not be on WhatsApp',
  131051: 'Unsupported message type',
  132001: 'Template does not exist or is not approved for this language',
  131009: 'A parameter value is invalid',
  190: 'Access token is invalid or expired',
  10: 'Permission denied – check the system user token permissions',
  130429: 'Rate limit hit',
  131056: 'Too many messages to this customer in a short time',
};

export class WhatsAppApiError extends AppError {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly graphCode?: number,
    readonly fbtraceId?: string,
  ) {
    super(message, 502, 'WHATSAPP_API_ERROR', { httpStatus, graphCode, fbtraceId });
  }

  /** Throttling and Meta-side failures are worth retrying; validation errors are not. */
  get retryable(): boolean {
    return this.httpStatus >= 500 || this.httpStatus === 429 || this.graphCode === 130429 || this.graphCode === 131056;
  }
}

type FetchFn = typeof fetch;

export interface WhatsAppCloudOptions {
  fetchImpl?: FetchFn;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** WhatsApp Cloud API client (Graph API). */
export class WhatsAppCloudClient implements WhatsAppClient {
  readonly mode = 'live' as const;
  private readonly fetchImpl: FetchFn;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly env: Env,
    options: WhatsAppCloudOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  private get messagesUrl() {
    return `https://graph.facebook.com/${this.env.WHATSAPP_GRAPH_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  }

  private async post(body: object): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.postOnce(body);
      } catch (err) {
        const retryable = err instanceof WhatsAppApiError ? err.retryable : err instanceof TypeError; // TypeError = network
        if (!retryable || attempt >= this.maxRetries) throw err;
        const delay = this.retryDelayMs * 2 ** attempt;
        logger.warn({ err, attempt: attempt + 1, delay }, 'WhatsApp API call failed, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async postOnce(body: object): Promise<unknown> {
    const res = await this.fetchImpl(this.messagesUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: GraphError };
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      const known = e.code !== undefined ? KNOWN_ERRORS[e.code] : undefined;
      const detail = e.error_data?.details ?? e.message ?? res.statusText;
      throw new WhatsAppApiError(
        known ? `${known} (${detail})` : `WhatsApp API error ${e.code ?? res.status}: ${detail}`,
        res.status,
        e.code,
        e.fbtrace_id,
      );
    }
    return json;
  }

  private async send(body: object): Promise<SendResult> {
    const json = (await this.post(body)) as { messages?: { id: string }[] };
    const messageId = json.messages?.[0]?.id;
    if (!messageId) throw new WhatsAppApiError('WhatsApp API returned no message id', 502);
    return { messageId };
  }

  async sendText(to: string, body: string) {
    validateText(body);
    return this.send(textPayload(to, body));
  }

  async sendButtons(to: string, message: ButtonMessage) {
    validateButtons(message);
    return this.send(buttonsPayload(to, message));
  }

  async sendCtaUrl(to: string, message: CtaUrlMessage) {
    validateCtaUrl(message);
    return this.send(ctaUrlPayload(to, message));
  }

  async sendTemplate(to: string, template: TemplateMessage) {
    return this.send(templatePayload(to, template));
  }

  async sendAddressRequest(to: string, body: string, prefill?: AddressPrefill, validationErrors?: Record<string, string>) {
    validateInteractiveBody(body);
    return this.send(addressPayload(to, body, prefill, validationErrors));
  }

  async sendOrderDetails(to: string, order: OrderDetailsMessage) {
    validateOrderDetails(order);
    return this.send(
      orderDetailsPayload(to, order, {
        paymentConfiguration: this.env.WHATSAPP_PAYMENT_CONFIGURATION!,
        catalogId: this.env.WHATSAPP_CATALOG_ID,
      }),
    );
  }

  async sendOrderStatus(to: string, status: OrderStatusMessage) {
    validateInteractiveBody(status.body);
    return this.send(orderStatusPayload(to, status));
  }

  async markRead(messageId: string) {
    await this.post(markReadPayload(messageId));
  }

  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined) {
    const signature = signatureHeader?.startsWith('sha256=') ? signatureHeader.slice(7) : '';
    return verifyHmacSha256(this.env.WHATSAPP_APP_SECRET ?? '', rawBody, signature);
  }

  verifySubscriptionToken(token: string | undefined) {
    return safeEqual(token, this.env.WHATSAPP_VERIFY_TOKEN);
  }
}
