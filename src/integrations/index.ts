import { env } from '../config/env.js';
import { RazorpayLiveClient } from './razorpay/live.js';
import { MockRazorpayClient } from './razorpay/mock.js';
import type { RazorpayClient } from './razorpay/types.js';
import { ShiprocketLiveClient } from './shiprocket/live.js';
import { MockShiprocketClient } from './shiprocket/mock.js';
import type { ShiprocketClient } from './shiprocket/types.js';
import { WhatsAppCloudClient } from './whatsapp/live.js';
import { MockWhatsAppClient } from './whatsapp/mock.js';
import type { WhatsAppClient } from './whatsapp/types.js';

/**
 * Integration registry. Each integration runs as `mock` or `live` according to
 * WHATSAPP_MODE / RAZORPAY_MODE / SHIPROCKET_MODE, so they can go live one at a time.
 */
export interface Integrations {
  whatsapp: WhatsAppClient;
  razorpay: RazorpayClient;
  shiprocket: ShiprocketClient;
}

let current: Integrations | undefined;

function build(): Integrations {
  return {
    whatsapp: env.WHATSAPP_MODE === 'live' ? new WhatsAppCloudClient(env) : new MockWhatsAppClient(),
    razorpay: env.RAZORPAY_MODE === 'live' ? new RazorpayLiveClient(env) : new MockRazorpayClient(),
    shiprocket: env.SHIPROCKET_MODE === 'live' ? new ShiprocketLiveClient(env) : new MockShiprocketClient(),
  };
}

export function integrations(): Integrations {
  current ??= build();
  return current;
}

/** Replace some or all clients (tests). Pass nothing to rebuild from the environment. */
export function setIntegrations(overrides?: Partial<Integrations>): Integrations {
  current = { ...build(), ...overrides };
  return current;
}

export function integrationModes() {
  const { whatsapp, razorpay, shiprocket } = integrations();
  return { whatsapp: whatsapp.mode, razorpay: razorpay.mode, shiprocket: shiprocket.mode };
}
