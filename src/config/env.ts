import 'dotenv/config';
import { z } from 'zod';

const mode = z.enum(['mock', 'live']).default('mock');
const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');
const optional = z.string().trim().optional().transform((v) => (v ? v : undefined));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TIMEZONE: z.string().default('Asia/Kolkata'),
    DATABASE_URL: z.string().min(1),

    ORDER_ID_PREFIX: z.string().regex(/^[A-Z]{1,5}$/).default('QZ'),
    REQUEST_ID_PREFIX: z.string().regex(/^[A-Z]{1,5}$/).default('RQ'),
    /** Indian D2C jewellery prices are normally GST-inclusive */
    PRICES_INCLUDE_GST: bool(true),
    DEFAULT_GST_RATE_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
    BRAND_NAME: z.string().default('Queziva'),

    WHATSAPP_MODE: mode,
    RAZORPAY_MODE: mode,
    SHIPROCKET_MODE: mode,

    WHATSAPP_GRAPH_VERSION: z.string().default('v23.0'),
    WHATSAPP_ACCESS_TOKEN: optional,
    WHATSAPP_PHONE_NUMBER_ID: optional,
    WHATSAPP_WABA_ID: optional,
    WHATSAPP_CATALOG_ID: optional,
    WHATSAPP_APP_SECRET: optional,
    WHATSAPP_VERIFY_TOKEN: optional,
    WHATSAPP_PAYMENT_CONFIGURATION: optional,

    // Approved message templates – used when the 24-hour customer service window has closed.
    // Definitions to submit in WhatsApp Manager: docs/whatsapp-templates.md
    WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),
    TEMPLATE_ORDER_UPDATE: z.string().default('qz_order_update'),
    TEMPLATE_ADDRESS_REQUEST: z.string().default('qz_address_request'),
    TEMPLATE_ORDER_CANCELLED: z.string().default('qz_order_cancelled'),
    TEMPLATE_PAYMENT_REQUEST: z.string().default('qz_payment_request'),
    TEMPLATE_ORDER_CONFIRMED: z.string().default('qz_order_confirmed'),
    TEMPLATE_ORDER_DISPATCHED: z.string().default('qz_order_dispatched'),
    TEMPLATE_OUT_FOR_DELIVERY: z.string().default('qz_out_for_delivery'),
    TEMPLATE_DELIVERY_ATTEMPT: z.string().default('qz_delivery_attempt'),
    TEMPLATE_ORDER_DELIVERED: z.string().default('qz_order_delivered'),
    TEMPLATE_FEEDBACK_REQUEST: z.string().default('qz_feedback_request'),
    TEMPLATE_IN_TRANSIT: z.string().default('qz_in_transit'),

    // Customer response timeouts (hours). 0 turns the reminder / auto-cancel off.
    APPROVAL_REMINDER_HOURS: z.coerce.number().min(0).default(12),
    APPROVAL_TIMEOUT_HOURS: z.coerce.number().min(0).default(48),
    ADDRESS_REMINDER_HOURS: z.coerce.number().min(0).default(12),
    ADDRESS_TIMEOUT_HOURS: z.coerce.number().min(0).default(72),
    PAYMENT_REMINDER_HOURS: z.coerce.number().min(0).default(12),
    /** The Pay Now request expires (and the order is cancelled) after this. Must be ≥ 1 hour if set. */
    PAYMENT_EXPIRY_HOURS: z.coerce.number().min(0).default(48),

    RAZORPAY_KEY_ID: optional,
    RAZORPAY_KEY_SECRET: optional,
    RAZORPAY_WEBHOOK_SECRET: optional,

    SHIPROCKET_EMAIL: optional,
    SHIPROCKET_PASSWORD: optional,
    SHIPROCKET_PICKUP_LOCATION: z.string().default('Primary'),
    SHIPROCKET_PICKUP_PINCODE: z.string().regex(/^\d{6}$/).default('110001'),
    SHIPROCKET_WEBHOOK_TOKEN: optional,
    SHIPROCKET_API_BASE: z.string().url().default('https://apiv2.shiprocket.in/v1/external'),
    /** Used as the billing email on Shiprocket orders when the customer has none (WhatsApp gives no email) */
    SHIPROCKET_FALLBACK_EMAIL: optional,

    // Shipping rules
    /** Which courier to pick from Shiprocket's options */
    SHIPPING_COURIER_STRATEGY: z.enum(['cheapest', 'fastest', 'recommended']).default('cheapest'),
    /** Orders whose product value (after discount) reaches this get free shipping. 0 = off. */
    FREE_SHIPPING_ABOVE_RUPEES: z.coerce.number().min(0).default(0),
    /** Charge customers a fixed amount instead of the courier rate. Empty = charge the actual rate. */
    // (Empty must mean "not set" – z.coerce.number() alone would turn '' into 0 = free shipping.)
    SHIPPING_FLAT_RATE_RUPEES: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).optional()),
    /** Box + padding added to the product weights */
    PACKAGING_WEIGHT_GRAMS: z.coerce.number().int().min(0).default(50),
    /** Round the customer shipping charge up to whole rupees (₹58.40 → ₹59) */
    SHIPPING_ROUND_TO_RUPEE: bool(true),

    ADMIN_SESSION_SECRET: optional,
    ADMIN_SESSION_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
    /** Used only by the seed script to create the first admin login */
    ADMIN_EMAIL: optional,
    ADMIN_PASSWORD: optional,
    ADMIN_NAME: z.string().default('Queziva Admin'),
  })
  .superRefine((env, ctx) => {
    const anyLive = env.WHATSAPP_MODE === 'live' || env.RAZORPAY_MODE === 'live' || env.SHIPROCKET_MODE === 'live';
    // The built-in development secret is public (it is in the source). Require a real one as soon as
    // anything is real – not only when NODE_ENV happens to be set to production.
    if ((env.NODE_ENV === 'production' || anyLive || env.APP_BASE_URL.startsWith('https://')) && (env.ADMIN_SESSION_SECRET?.length ?? 0) < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_SESSION_SECRET'],
        message: 'must be at least 32 random characters in production, with any live integration, or on https',
      });
    }
    // Real customers on WhatsApp must only ever meet real payments and real shipping: with a mocked
    // Razorpay, money paid through the live Pay Now could never be verified; with a mocked Shiprocket
    // customers would be quoted invented rates. (It also keeps the public mock webhook secrets and the
    // test tools unusable once real customers exist.)
    if (env.WHATSAPP_MODE === 'live' && (env.RAZORPAY_MODE !== 'live' || env.SHIPROCKET_MODE !== 'live')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHATSAPP_MODE'],
        message: 'WhatsApp can only go live after Razorpay and Shiprocket (set RAZORPAY_MODE=live and SHIPROCKET_MODE=live)',
      });
    }
    const requireWhen = (active: boolean, keys: (keyof typeof env)[], label: string) => {
      if (!active) return;
      for (const key of keys) {
        if (!env[key]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `required when ${label}` });
        }
      }
    };
    requireWhen(
      env.WHATSAPP_MODE === 'live',
      [
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_CATALOG_ID',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_VERIFY_TOKEN',
        'WHATSAPP_PAYMENT_CONFIGURATION',
      ],
      'WHATSAPP_MODE=live',
    );
    requireWhen(
      env.RAZORPAY_MODE === 'live',
      ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
      'RAZORPAY_MODE=live',
    );
    requireWhen(
      env.SHIPROCKET_MODE === 'live',
      // Shiprocket rejects orders without billing_email, and WhatsApp gives us no customer email.
      ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_WEBHOOK_TOKEN', 'SHIPROCKET_FALLBACK_EMAIL'],
      'SHIPROCKET_MODE=live',
    );
  });

export type Env = z.infer<typeof schema>;

/** Validates a set of environment variables (exported for tests). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export const env = parseEnv(process.env);

/** True when every integration is mocked – the only situation in which test tools and mock secrets apply. */
export const allMocked = env.WHATSAPP_MODE === 'mock' && env.RAZORPAY_MODE === 'mock' && env.SHIPROCKET_MODE === 'mock';

/** Secret for signing admin session cookies. Development falls back to a fixed, non-secret value. */
export const sessionSecret = env.ADMIN_SESSION_SECRET ?? 'dev-only-session-secret-do-not-use-in-production';
