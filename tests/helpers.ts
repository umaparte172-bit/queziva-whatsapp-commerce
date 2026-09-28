import { prisma } from '../src/lib/prisma.js';

/** Empties every table (children first). */
export async function resetDb() {
  await prisma.$transaction([
    prisma.orderEvent.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.shipment.deleteMany(),
    prisma.message.deleteMany(),
    prisma.scheduledJob.deleteMany(),
    prisma.order.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.product.deleteMany(),
    prisma.webhookEvent.deleteMany(),
    prisma.counter.deleteMany(),
    prisma.setting.deleteMany(),
    prisma.adminUser.deleteMany(),
  ]);
}

export function seedProduct(overrides: Partial<Parameters<typeof prisma.product.create>[0]['data']> = {}) {
  return prisma.product.create({
    data: {
      sku: 'QZ-EAR-001',
      retailerId: 'QZ-EAR-001',
      name: 'Pearl Drop Earrings',
      pricePaise: 29900,
      stock: 1,
      gstRateBps: 300,
      weightGrams: 60,
      ...overrides,
    },
  });
}
