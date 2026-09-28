import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../../lib/http.js';
import { createProduct, listProducts, productInput, productUpdate, updateProduct } from '../../services/products.js';

export const productsRouter = Router();

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
