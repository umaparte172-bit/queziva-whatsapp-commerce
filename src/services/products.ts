import { Prisma, type Product } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { containsText, prisma } from '../lib/prisma.js';

const paise = z.number().int().min(0).max(100_000_000);

export const productInput = z.object({
  sku: z.string().trim().min(1).max(64),
  /** Content ID of the item in the Meta catalogue – defaults to the SKU */
  retailerId: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  imageUrl: z.string().url().nullish(),
  pricePaise: paise,
  stock: z.number().int().min(0).max(1_000_000),
  gstRateBps: z.number().int().min(0).max(10_000).default(env.DEFAULT_GST_RATE_BPS),
  hsnCode: z.string().trim().max(16).nullish(),
  weightGrams: z.number().int().min(1).max(100_000).default(100),
  lengthCm: z.number().positive().max(500).default(10),
  breadthCm: z.number().positive().max(500).default(10),
  heightCm: z.number().positive().max(500).default(5),
  active: z.boolean().default(true),
});

export const productUpdate = productInput.partial();

export type ProductInput = z.infer<typeof productInput>;
export type ProductUpdate = z.infer<typeof productUpdate>;

function duplicateError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ConflictError('Another product already uses this SKU or catalogue ID');
  }
  throw err;
}

export function listProducts(opts: { search?: string; includeInactive?: boolean }): Promise<Product[]> {
  const search = opts.search?.trim();
  return prisma.product.findMany({
    where: {
      ...(opts.includeInactive ? {} : { active: true }),
      ...(search
        ? { OR: [{ sku: { contains: search.toUpperCase() } }, { name: containsText(search) }, { retailerId: containsText(search) }] }
        : {}),
    },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    take: 500,
  });
}

export function createProduct(input: ProductInput): Promise<Product> {
  return prisma.product
    .create({ data: { ...input, sku: input.sku.toUpperCase(), retailerId: input.retailerId ?? input.sku } })
    .catch(duplicateError);
}

export async function updateProduct(id: string, input: ProductUpdate): Promise<Product> {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Product', id);
  return prisma.product
    .update({ where: { id }, data: { ...input, ...(input.sku ? { sku: input.sku.toUpperCase() } : {}) } })
    .catch(duplicateError);
}
