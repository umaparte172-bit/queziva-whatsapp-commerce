import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { runDueJobs } from './jobs.js';
import { simulateCustomerPayment, testModeEnabled } from './testTools.js';
import { applyTrackingUpdate } from './tracking.js';
import { processWhatsAppWebhook } from './whatsappInbound.js';

/**
 * Customer-side simulator for demos and manual testing (test mode only). Every action is turned
 * into the same webhook payload WhatsApp / Shiprocket would send and goes through the normal
 * processing, so the demo exercises the real workflow.
 */

export function simulatorEnabled(): boolean {
  return env.WHATSAPP_MODE === 'mock';
}

function assertEnabled() {
  if (!simulatorEnabled()) throw new ConflictError('The simulator is only available when WhatsApp runs in mock mode');
}

/** Simulated customers use 91999… numbers so they are easy to tell apart. */
export function isSimulatorNumber(waId: string): boolean {
  return /^91999\d{7}$/.test(waId);
}

function assertSimNumber(waId: string) {
  if (!isSimulatorNumber(waId)) throw new ValidationError('Simulator customers use numbers starting 91999 followed by 7 digits');
}

const ts = () => String(Math.floor(Date.now() / 1000));
const wamid = () => `wamid.SIM_${randomUUID()}`;

async function inbound(waId: string, name: string | undefined, message: object) {
  // Real WhatsApp sends the same profile name with every message; keep the one the chat started with.
  name ??= (await prisma.customer.findUnique({ where: { waId } }))?.name ?? undefined;
  return processWhatsAppWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'SIMULATOR',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: 'SIMULATOR', phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID ?? 'SIMULATOR' },
              contacts: [{ profile: { name: name ?? 'Demo Customer' }, wa_id: waId }],
              messages: [{ from: waId, id: wamid(), timestamp: ts(), ...message }],
            },
          },
        ],
      },
    ],
  });
}

export async function sendCart(waId: string, name: string, items: { retailerId: string; quantity: number }[]) {
  assertEnabled();
  assertSimNumber(waId);
  const products = await prisma.product.findMany({ where: { retailerId: { in: items.map((i) => i.retailerId) } } });
  const price = new Map(products.map((p) => [p.retailerId, p.pricePaise / 100]));
  await inbound(waId, name, {
    type: 'order',
    order: {
      catalog_id: env.WHATSAPP_CATALOG_ID ?? 'SIMULATOR',
      product_items: items.map((i) => ({ product_retailer_id: i.retailerId, quantity: i.quantity, item_price: price.get(i.retailerId) ?? 0, currency: 'INR' })),
    },
  });
}

export async function sendText(waId: string, text: string) {
  assertEnabled();
  assertSimNumber(waId);
  await inbound(waId, undefined, { type: 'text', text: { body: text } });
}

/** Taps a reply button – on an interactive message, or a quick reply on a template. */
export async function tapButton(waId: string, id: string, title: string, onTemplate: boolean) {
  assertEnabled();
  assertSimNumber(waId);
  await inbound(
    waId,
    undefined,
    onTemplate
      ? { type: 'button', button: { payload: id, text: title } }
      : { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } },
  );
}

export async function submitAddress(waId: string, values: Record<string, string>) {
  assertEnabled();
  assertSimNumber(waId);
  await inbound(waId, undefined, {
    type: 'interactive',
    interactive: { type: 'nfm_reply', nfm_reply: { name: 'address_message', body: 'Sent', response_json: JSON.stringify({ values }) } },
  });
}

async function latestOrder(waId: string) {
  const customer = await prisma.customer.findUnique({ where: { waId } });
  if (!customer) throw new NotFoundError('Simulated customer', waId);
  const order = await prisma.order.findFirst({ where: { customerId: customer.id }, orderBy: { createdAt: 'desc' }, include: { shipments: true } });
  if (!order) throw new ConflictError('This customer has no order yet');
  return order;
}

export async function pay(waId: string, outcome: 'captured' | 'failed') {
  assertEnabled();
  if (!testModeEnabled()) throw new ConflictError('Payments can only be simulated when WhatsApp, Razorpay and Shiprocket all run in mock mode');
  const order = await latestOrder(waId);
  await simulateCustomerPayment(order.id, outcome);
  await runDueJobs(); // shipment creation, so the courier panel is ready straight away
}

export const COURIER_STATUSES = ['PICKED UP', 'IN TRANSIT', 'OUT FOR DELIVERY', 'UNDELIVERED', 'DELIVERED', 'RTO INITIATED'] as const;

export async function courierUpdate(waId: string, status: (typeof COURIER_STATUSES)[number]) {
  assertEnabled();
  if (env.SHIPROCKET_MODE !== 'mock') throw new ConflictError('Courier updates can only be simulated when Shiprocket runs in mock mode');
  const order = await latestOrder(waId);
  const shipment = order.shipments.find((s) => s.awb && s.currentStatus !== 'CANCELLED');
  if (!shipment?.awb) throw new ConflictError('The shipment has no AWB yet');
  await applyTrackingUpdate({ awb: shipment.awb, status, at: new Date(), location: 'Simulator hub', source: 'webhook' });
}

/** Runs every background job that would be due `hours` from now (reminders, timeouts, feedback). */
export async function fastForward(hours: number) {
  assertEnabled();
  if (!(hours > 0 && hours <= 24 * 14)) throw new ValidationError('Choose between 1 hour and 14 days');
  const at = new Date(Date.now() + hours * 60 * 60 * 1000);
  // Only the simulated customers' orders – real orders' reminders and expiries keep their times.
  const simOrders = await prisma.order.findMany({ where: { customer: { waId: { startsWith: '91999' } } }, select: { id: true } });
  const orderIds = simOrders.map((o) => o.id);
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const ran = await runDueJobs(at, 50, orderIds);
    total += ran;
    if (ran === 0) break;
  }
  return total;
}

/** Everything the simulator screen shows for one customer. */
export async function simulatorState(waId: string) {
  assertEnabled();
  const [customer, products, simCustomers] = await Promise.all([
    prisma.customer.findUnique({ where: { waId } }),
    prisma.product.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    prisma.customer.findMany({ where: { waId: { startsWith: '91999' } }, orderBy: { updatedAt: 'desc' }, take: 20 }),
  ]);
  const messages = customer
    ? (await prisma.message.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'desc' }, take: 300 })).reverse()
    : [];
  const order = customer
    ? await prisma.order.findFirst({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        include: { shipments: true, payments: { where: { status: { in: ['CREATED', 'FAILED'] } } } },
      })
    : null;

  return {
    customer: customer && { waId: customer.waId, name: customer.name },
    customers: simCustomers.filter((c) => isSimulatorNumber(c.waId)).map((c) => ({ waId: c.waId, name: c.name })),
    catalog: products.map((p) => ({ retailerId: p.retailerId, name: p.name, imageUrl: p.imageUrl, pricePaise: p.pricePaise, stock: p.stock })),
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      type: m.type,
      status: m.status,
      error: m.error,
      payload: m.payload,
      createdAt: m.createdAt,
    })),
    order: order && {
      id: order.id,
      requestNumber: order.requestNumber,
      orderNumber: order.orderNumber,
      status: order.status,
      awb: order.shipments.find((s) => s.awb)?.awb ?? null,
      canPay: order.status === 'PAYMENT_REQUESTED' && order.payments.length > 0,
    },
    courierStatuses: COURIER_STATUSES,
  };
}
