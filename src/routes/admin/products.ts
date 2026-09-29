import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { ah } from '../../lib/http.js';
import { createProduct, listProducts, productInput, productUpdate, updateProduct } from '../../services/products.js';

export const productsRouter = Router();

const imageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' });

function imageExtension(body: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'jpg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

productsRouter.post(
  '/product-images',
  imageBody,
  ah(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const extension = imageExtension(body);
    if (!extension) throw new AppError('Choose a valid JPG, PNG or WebP image', 400, 'INVALID_IMAGE');
    const directory = path.resolve(process.cwd(), 'public', 'catalogue', 'uploads');
    await mkdir(directory, { recursive: true });
    const filename = `${randomUUID()}.${extension}`;
    await writeFile(path.join(directory, filename), body, { flag: 'wx' });
    res.status(201).json({ imageUrl: `${env.APP_BASE_URL.replace(/\/$/, '')}/catalogue/uploads/${filename}` });
  }),
);

productsRouter.get(
  '/products',
  ah(async (req, res) => {
    const q = z
      .object({ q: z.string().max(100).optional(), includeInactive: z.enum(['1', 'true']).optional() })
      .parse(req.query);
    res.json({ products: await listProducts({ search: q.q, includeInactive: Boolean(q.includeInactive) }) });
  }),
);

productsRouter.post(
  '/products',
  ah(async (req, res) => {
    res.status(201).json({ product: await createProduct(productInput.parse(req.body)) });
  }),
);

productsRouter.patch(
  '/products/:id',
  ah(async (req, res) => {
    res.json({ product: await updateProduct(req.params.id!, productUpdate.parse(req.body)) });
  }),
);
