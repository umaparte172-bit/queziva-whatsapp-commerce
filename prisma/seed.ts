import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/auth.js';

/**
 * Sample catalogue for local development. `retailerId` must match the Content ID of the
 * item in the Meta WhatsApp Catalogue – replace these with Queziva's real SKUs before go-live.
 */
const products = [
  {
    sku: 'QZ-EAR-001',
    retailerId: 'QZ-EAR-001',
    name: 'Pearl Drop Earrings',
    pricePaise: 29900,
    stock: 1, // deliberately low: "customer asks for 2, only 1 available" test case
    hsnCode: '7117',
    weightGrams: 60,
    lengthCm: 8,
    breadthCm: 8,
    heightCm: 4,
  },
  {
    sku: 'QZ-NCK-001',
    retailerId: 'QZ-NCK-001',
    name: 'Kundan Choker Necklace',
    pricePaise: 34800,
    stock: 5,
    hsnCode: '7117',
    weightGrams: 180,
    lengthCm: 15,
    breadthCm: 12,
    heightCm: 5,
  },
  {
    sku: 'QZ-BNG-001',
    retailerId: 'QZ-BNG-001',
    name: 'Gold-Plated Bangle Set (2)',
    pricePaise: 44900,
    stock: 8,
    hsnCode: '7117',
    weightGrams: 150,
    lengthCm: 10,
    breadthCm: 10,
    heightCm: 6,
  },
  {
    sku: 'QZ-RNG-001',
    retailerId: 'QZ-RNG-001',
    name: 'Adjustable Solitaire Ring',
    pricePaise: 19900,
    stock: 12,
    hsnCode: '7117',
    weightGrams: 30,
    lengthCm: 6,
    breadthCm: 6,
    heightCm: 4,
  },
  {
    sku: 'QZ-EAR-002',
    retailerId: 'QZ-EAR-002',
    name: 'Oxidised Jhumka Earrings',
    pricePaise: 24900,
    stock: 0,
    hsnCode: '7117',
    weightGrams: 70,
    lengthCm: 8,
    breadthCm: 8,
    heightCm: 4,
  },
];

const prisma = new PrismaClient();

async function main() {
  // Sample products are for development and demos only – production uses the real catalogue.
  if (process.env.NODE_ENV !== 'production') {
    for (const product of products) {
      await prisma.product.upsert({
        where: { sku: product.sku },
        create: { ...product, gstRateBps: 300 },
        update: {},
      });
    }
    console.log(`Seeded ${products.length} sample products`);
  }

  // First admin login, from ADMIN_EMAIL / ADMIN_PASSWORD – only when no admin exists yet.
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if ((await prisma.adminUser.count()) === 0) {
    if (email && password) {
      await prisma.adminUser.create({
        data: { email, name: process.env.ADMIN_NAME || 'Queziva Admin', passwordHash: await hashPassword(password) },
      });
      console.log(`Created admin login ${email}`);
    } else {
      console.log('No admin login yet – set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run admin:create -- <email> <password>');
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
