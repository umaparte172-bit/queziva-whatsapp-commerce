import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { rupeesToPaise } from '../../lib/money.js';
import { parseShiprocketTime } from '../../domain/tracking.js';
import { safeEqual } from '../../lib/signature.js';
import type {
  AwbAssignment,
  CourierOption,
  CreatedShipment,
  CreateShipmentRequest,
  RateQuoteRequest,
  ShiprocketClient,
  TrackingInfo,
} from './types.js';

export class ShiprocketApiError extends AppError {
  constructor(
    message: string,
    readonly httpStatus: number,
    details?: unknown,
  ) {
    super(message, 502, 'SHIPROCKET_API_ERROR', details);
  }

  get retryable(): boolean {
    return this.httpStatus >= 500 || this.httpStatus === 429;
  }
}

type FetchFn = typeof fetch;
type Json = any;

export interface ShiprocketOptions {
  fetchImpl?: FetchFn;
  maxRetries?: number;
  retryDelayMs?: number;
  now?: () => number;
}

/** Tokens are valid for 10 days; refresh a day early. */
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000;

const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

const rupees = (paise: number) => Math.round(paise) / 100;

/** "2026-09-28 17:45" in IST, as Shiprocket expects. */
function orderDate(date: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function errorMessage(json: Json, status: number): string {
  if (typeof json?.message === 'string' && json.message) return json.message;
  if (json?.errors && typeof json.errors === 'object') {
    return Object.entries(json.errors)
      .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(', ') : msgs}`)
      .join('; ');
  }
  return `HTTP ${status}`;
}

/** Shiprocket external API v1 client. */
export class ShiprocketLiveClient implements ShiprocketClient {
  readonly mode = 'live' as const;
  private readonly fetchImpl: FetchFn;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };
  private pendingLogin?: Promise<string>;

  constructor(
    private readonly env: Env,
    options: ShiprocketOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.now = options.now ?? Date.now;
  }

  // ── Auth ────────────────────────────────────────────────────

  private async login(): Promise<string> {
    const res = await this.fetchImpl(`${this.env.SHIPROCKET_API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.env.SHIPROCKET_EMAIL, password: this.env.SHIPROCKET_PASSWORD }),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || typeof json.token !== 'string') {
      throw new ShiprocketApiError(`Shiprocket login failed: ${errorMessage(json, res.status)}`, res.status);
    }
    this.token = { value: json.token, expiresAt: this.now() + TOKEN_TTL_MS };
    logger.info('Shiprocket token refreshed');
    return json.token;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    // Several requests at once share a single login call.
    this.pendingLogin ??= this.login().finally(() => {
      this.pendingLogin = undefined;
    });
    return this.pendingLogin;
  }

  // ── HTTP ────────────────────────────────────────────────────

  private async request(method: 'GET' | 'POST', path: string, body?: object): Promise<{ status: number; json: Json }> {
    let reauthenticated = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const token = await this.getToken();
        const res = await this.fetchImpl(`${this.env.SHIPROCKET_API_BASE}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const json = (await res.json().catch(() => ({}))) as Json;

        if (res.status === 401 && !reauthenticated) {
          // Token revoked or expired early – log in again once.
          this.token = undefined;
          reauthenticated = true;
          attempt--;
          continue;
        }
        if (res.status >= 500 || res.status === 429) {
          throw new ShiprocketApiError(`Shiprocket error: ${errorMessage(json, res.status)}`, res.status);
        }
        return { status: res.status, json };
      } catch (err) {
        // Only reads are retried automatically: a POST that timed out may already have created an
        // order or assigned an AWB, so repeating it could duplicate it. Those are retried by the job.
        const retryable = method === 'GET' && (err instanceof ShiprocketApiError ? err.retryable : err instanceof TypeError || isTimeout(err));
        if (!retryable || attempt >= this.maxRetries) throw err;
        const delay = this.retryDelayMs * 2 ** attempt;
        logger.warn({ err, path, attempt: attempt + 1 }, 'Shiprocket call failed, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: object): Promise<Json> {
    const { status, json } = await this.request(method, path, body);
    if (status >= 400) throw new ShiprocketApiError(`Shiprocket: ${errorMessage(json, status)}`, status, json?.errors);
    return json;
  }

  // ── API ─────────────────────────────────────────────────────

  async getRates(r: RateQuoteRequest): Promise<CourierOption[]> {
    const params = new URLSearchParams({
      pickup_postcode: r.pickupPincode,
      delivery_postcode: r.deliveryPincode,
      weight: r.weightKg.toFixed(3),
      cod: r.cod ? '1' : '0',
      declared_value: String(rupees(r.declaredValuePaise)),
      length: String(r.lengthCm),
      breadth: String(r.breadthCm),
      height: String(r.heightCm),
    });
    const { status, json } = await this.request('GET', `/courier/serviceability/?${params}`);
    // 404 = no courier delivers to this pincode
    if (status === 404) return [];
    if (status >= 400) throw new ShiprocketApiError(`Shiprocket: ${errorMessage(json, status)}`, status);

    const data = json?.data ?? {};
    const recommendedId = data.recommended_courier_company_id ?? data.shiprocket_recommended_courier_id ?? null;
    return (data.available_courier_companies ?? [])
      .map((c: Json): CourierOption | null => {
        const rate = Number(c.rate ?? c.freight_charge);
        if (!Number.isFinite(rate) || c.blocked === 1) return null;
        const etd = Number.parseInt(String(c.estimated_delivery_days ?? ''), 10);
        const rating = Number(c.rating);
        return {
          courierId: Number(c.courier_company_id),
          courierName: String(c.courier_name),
          ratePaise: rupeesToPaise(rate),
          etdDays: Number.isFinite(etd) ? etd : null,
          rating: Number.isFinite(rating) && rating > 0 ? rating : null,
          recommended: recommendedId !== null && Number(c.courier_company_id) === Number(recommendedId),
        };
      })
      .filter((c: CourierOption | null): c is CourierOption => c !== null);
  }

  async createOrder(req: CreateShipmentRequest): Promise<CreatedShipment> {
    const [firstName, ...rest] = req.customer.name.trim().split(/\s+/);
    const email = req.customer.email ?? this.env.SHIPROCKET_FALLBACK_EMAIL;
    const json = await this.call('POST', '/orders/create/adhoc', {
      order_id: req.orderNumber,
      order_date: orderDate(req.orderDate),
      pickup_location: req.pickupLocation,
      billing_customer_name: firstName,
      billing_last_name: rest.join(' '),
      billing_address: req.customer.address,
      billing_address_2: req.customer.address2 ?? '',
      billing_city: req.customer.city,
      billing_pincode: req.customer.pincode,
      billing_state: req.customer.state,
      billing_country: 'India',
      ...(email ? { billing_email: email } : {}),
      billing_phone: req.customer.phone,
      shipping_is_billing: true,
      order_items: req.items.map((i) => ({
        name: i.name,
        sku: i.sku,
        units: i.units,
        selling_price: rupees(i.sellingPricePaise),
        discount: 0,
        tax: i.taxRateBps !== undefined ? i.taxRateBps / 100 : '',
        hsn: i.hsn ?? '',
      })),
      payment_method: req.paymentMethod,
      shipping_charges: rupees(req.shippingPaise),
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: rupees(req.discountPaise),
      sub_total: rupees(req.subTotalPaise),
      length: req.lengthCm,
      breadth: req.breadthCm,
      height: req.heightCm,
      weight: Number(req.weightKg.toFixed(3)),
    });
    if (!json?.order_id || !json?.shipment_id) {
      throw new ShiprocketApiError(`Shiprocket did not create the order: ${errorMessage(json, 200)}`, 200, json);
    }
    return { shiprocketOrderId: String(json.order_id), shipmentId: String(json.shipment_id) };
  }

  async assignAwb(shipmentId: string, courierId?: number): Promise<AwbAssignment> {
    const json = await this.call('POST', '/courier/assign/awb', {
      shipment_id: Number(shipmentId),
      ...(courierId ? { courier_id: courierId } : {}),
    });
    const data = json?.response?.data ?? {};
    if (json?.awb_assign_status !== 1 || !data.awb_code) {
      throw new ShiprocketApiError(`AWB not assigned: ${data.awb_assign_error ?? errorMessage(json, 200)}`, 200, json);
    }
    return { awb: String(data.awb_code), courierId: Number(data.courier_company_id), courierName: String(data.courier_name) };
  }

  async requestPickup(shipmentId: string): Promise<void> {
    const { status, json } = await this.request('POST', '/courier/generate/pickup', { shipment_id: [Number(shipmentId)] });
    const message = errorMessage(json, status);
    // Asking again for a shipment that is already queued is fine.
    if (status >= 400 && !/already/i.test(message)) throw new ShiprocketApiError(`Pickup request failed: ${message}`, status);
    if (status < 400 && json?.pickup_status !== 1 && !/already/i.test(message)) {
      throw new ShiprocketApiError(`Pickup request failed: ${message}`, status, json);
    }
  }

  async generateManifest(shipmentId: string): Promise<void> {
    const { status, json } = await this.request('POST', '/manifests/generate', { shipment_id: [Number(shipmentId)] });
    const message = errorMessage(json, status);
    // A manifest that already exists is fine.
    if (status >= 400 && !/already/i.test(message)) throw new ShiprocketApiError(`Manifest failed: ${message}`, status);
  }

  async cancelOrder(shiprocketOrderId: string): Promise<void> {
    await this.call('POST', '/orders/cancel', { ids: [Number(shiprocketOrderId)] });
  }

  async track(awb: string): Promise<TrackingInfo> {
    const json = await this.call('GET', `/courier/track/awb/${encodeURIComponent(awb)}`);
    const t = json?.tracking_data ?? {};
    const activities: Json[] = t.shipment_track_activities ?? [];
    const label = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toUpperCase() !== 'NA' ? v.trim() : undefined);
    const events = activities
      .map((a) => ({
        status: label(a['sr-status-label']) ?? label(a.activity) ?? label(a.status) ?? '',
        location: a.location ? String(a.location) : null,
        at: parseShiprocketTime(a.date),
      }))
      // A scan without a usable time or status cannot be ordered against others – skip it.
      .filter((e): e is { status: string; location: string | null; at: Date } => e.at !== null && e.status !== '');
    return {
      awb,
      currentStatus: label(t.shipment_track?.[0]?.current_status) ?? events[0]?.status ?? 'UNKNOWN',
      trackingUrl: t.track_url ?? `https://shiprocket.co/tracking/${awb}`,
      events,
    };
  }

  verifyWebhookToken(token: string | undefined): boolean {
    return safeEqual(token, this.env.SHIPROCKET_WEBHOOK_TOKEN);
  }
}
