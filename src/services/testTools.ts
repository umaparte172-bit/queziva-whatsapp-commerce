import { allMocked } from '../config/env.js';
import { integrations } from '../integrations/index.js';
import { MockRazorpayClient } from '../integrations/razorpay/mock.js';
import { ConflictError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { processWhatsAppWebhook } from './whatsappInbound.js';

/** Simulated payments need every integration mocked: a simulated payment creates a shipment. */
export function testModeEnabled(): boolean {
  return allMocked;
}

/**
 * Test mode only: plays the customer paying in WhatsApp. Creates the payment in the mock Razorpay
 * and delivers the same payment webhook WhatsApp would send, so the real verification path runs.
 */
export async function simulateCustomerPayment(orderId: string, outcome: 'captured' | 'failed' = 'captured') {
  const razorpay = integrations().razorpay;
  if (!testModeEnabled() || !(razorpay instanceof MockRazorpayClient)) {
    throw new ConflictError('Simulated payments are only available in test mode');
  }
  const payment = await prisma.payment.findFirst({
    where: { orderId, status: { in: ['CREATED', 'PENDING', 'FAILED'] } },
    orderBy: { createdAt: 'desc' },
    include: { order: { include: { customer: true } } },
  });
  if (!payment) throw new ConflictError('This order has no open payment request');

  const rp = razorpay.simulatePayment({ amountPaise: payment.amountPaise, referenceId: payment.referenceId, outcome });
  const now = String(Math.floor(Date.now() / 1000));
  await processWhatsAppWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'TEST',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'TEST', display_phone_number: 'TEST' },
              statuses: [
                {
                  id: payment.waMessageId ?? `wamid.TEST_${payment.id}`,
                  status: outcome,
                  type: 'payment',
                  timestamp: now,
                  recipient_id: payment.order.customer.waId,
                  payment: {
                    reference_id: payment.referenceId,
                    amount: { value: payment.amountPaise, offset: 100 },
                    currency: 'INR',
                    transaction: { id: `txn_${rp.id}`, pg_transaction_id: rp.id, type: 'razorpay', status: outcome === 'captured' ? 'success' : 'failed' },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return rp.id;
}
