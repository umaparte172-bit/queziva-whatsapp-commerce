import { Router } from 'express';
import { z } from 'zod';
import { ORDER_STATUSES } from '../../domain/orderStatus.js';
import { ah } from '../../lib/http.js';
import { closeUndelivered } from '../../services/cancellation.js';
import { saveAddressByAdmin } from '../../services/customerFlow.js';
import { runDueJobs } from '../../services/jobs.js';
import { quoteShipping, setManualShipping, shippingOptions } from '../../services/shipping.js';
import { simulateCustomerPayment } from '../../services/testTools.js';
import {
  addItem,
  addNote,
  listOrders,
  orderDetail,
  orderSummary,
  removeItem,
  replaceItem,
  runAction,
  setDiscount,
  setItemQuantity,
  type AdminContext,
} from '../../services/adminOrders.js';

export const ordersRouter = Router();

const version = { expectedVersion: z.number().int().min(0) };

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.enum(ORDER_STATUSES)).optional()),
  q: z.string().max(100).optional(),
  stockIssues: z.enum(['1', 'true']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

ordersRouter.get(
  '/orders',
  ah(async (req, res) => {
    const q = listQuery.parse(req.query);
    res.json(
      await listOrders({
        statuses: q.status,
        search: q.q,
        stockIssuesOnly: Boolean(q.stockIssues),
        page: q.page,
        pageSize: q.pageSize,
      }),
    );
  }),
);

ordersRouter.get('/orders/summary', ah(async (_req, res) => res.json(await orderSummary())));

ordersRouter.get('/orders/:id', ah(async (req, res) => res.json(await orderDetail(req.params.id!))));

/**
 * Runs an edit, then responds with the refreshed order so the UI always shows the latest version.
 * A `warning` (e.g. the WhatsApp message could not be sent) is passed through for the admin to see.
 */
function edit<T extends z.ZodTypeAny>(schema: T, run: (orderId: string, body: z.infer<T>, ctx: AdminContext, params: Record<string, string>) => Promise<unknown>) {
  return ah(async (req, res) => {
    const body = schema.parse(req.body) as z.infer<T> & { expectedVersion: number };
    const orderId = req.params.id!;
    const result = await run(orderId, body, { adminId: req.admin!.id, expectedVersion: body.expectedVersion }, req.params as Record<string, string>);
    const warning = (result as { warning?: string } | undefined)?.warning;
    res.json({ ...(await orderDetail(orderId)), ...(warning ? { warning } : {}) });
  });
}

ordersRouter.patch(
  '/orders/:id/items/:itemId',
  edit(z.object({ ...version, quantity: z.number().int() }), (id, b, ctx, p) => setItemQuantity(id, p.itemId!, b.quantity, ctx)),
);

ordersRouter.post(
  '/orders/:id/items/:itemId/remove',
  edit(z.object(version), (id, _b, ctx, p) => removeItem(id, p.itemId!, ctx)),
);

ordersRouter.post(
  '/orders/:id/items/:itemId/replace',
  edit(z.object({ ...version, productId: z.string().min(1), quantity: z.number().int().optional() }), (id, b, ctx, p) =>
    replaceItem(id, p.itemId!, b.productId, b.quantity, ctx),
  ),
);

ordersRouter.post(
  '/orders/:id/items',
  edit(z.object({ ...version, productId: z.string().min(1), quantity: z.number().int() }), (id, b, ctx) =>
    addItem(id, b.productId, b.quantity, ctx),
  ),
);

ordersRouter.put(
  '/orders/:id/discount',
  edit(z.object({ ...version, discountPaise: z.number().int(), reason: z.string().trim().max(200).optional() }), (id, b, ctx) =>
    setDiscount(id, b.discountPaise, b.reason || undefined, ctx),
  ),
);

ordersRouter.post(
  '/orders/:id/actions/:action',
  edit(z.object({ ...version, reason: z.string().trim().max(500).optional() }), (id, b, ctx, p) => {
    const action = z
      .enum([
        'start_review',
        'approve',
        'resend',
        'quote_shipping',
        'request_payment',
        'withdraw_payment',
        'create_shipment',
        'retry_refund',
        'refresh_tracking',
        'mark_delivered',
        'cancel',
      ])
      .parse(p.action);
    return runAction(id, action, { ...ctx, reason: b.reason });
  }),
);

const addressBody = z.object({
  ...version,
  name: z.string().max(100),
  phone: z.string().max(20),
  house: z.string().max(200),
  street: z.string().max(300),
  landmark: z.string().max(200).optional(),
  city: z.string().max(100),
  state: z.string().max(100),
  pincode: z.string().max(10),
});

/** Admin enters the address (e.g. the customer typed it as a message instead of using the form). */
ordersRouter.put(
  '/orders/:id/address',
  edit(addressBody, (id, { expectedVersion, ...fields }, ctx) => saveAddressByAdmin(id, fields, ctx.adminId, expectedVersion)),
);

/** Live courier options for the delivery pincode, with what the customer would pay for each. */
ordersRouter.get('/orders/:id/shipping-options', ah(async (req, res) => res.json(await shippingOptions(req.params.id!))));

/** Pick a courier from the options, or set the customer's shipping charge by hand. */
ordersRouter.put(
  '/orders/:id/shipping',
  edit(
    z.union([
      z.object({ ...version, courierId: z.number().int().positive() }),
      z.object({ ...version, manualChargePaise: z.number().int().min(0), reason: z.string().trim().min(1).max(200) }),
    ]),
    async (id, b, ctx) => {
      if ('courierId' in b) {
        const result = await quoteShipping(id, { actor: 'ADMIN', actorRef: ctx.adminId, expectedVersion: ctx.expectedVersion }, b.courierId);
        return result.ok ? {} : { warning: result.message };
      }
      await setManualShipping(id, b.manualChargePaise, b.reason, ctx.adminId, ctx.expectedVersion);
      return {};
    },
  ),
);

/** Close a dispatched order whose parcel will not reach the customer (returned, lost, damaged). */
ordersRouter.post(
  '/orders/:id/close',
  edit(
    z.object({ ...version, reason: z.string().trim().min(1).max(500), restock: z.boolean(), refund: z.boolean() }),
    (id, b, ctx) => closeUndelivered(id, { adminId: ctx.adminId, expectedVersion: ctx.expectedVersion, reason: b.reason, restock: b.restock, refund: b.refund }),
  ),
);

/** Test mode only: play the customer paying (or failing to pay) the open payment request. */
ordersRouter.post(
  '/orders/:id/test-payment',
  ah(async (req, res) => {
    const { outcome } = z.object({ outcome: z.enum(['captured', 'failed']).default('captured') }).parse(req.body);
    await simulateCustomerPayment(req.params.id!, outcome);
    await runDueJobs(); // create the shipment straight away instead of on the next background tick
    res.json(await orderDetail(req.params.id!));
  }),
);

ordersRouter.post(
  '/orders/:id/notes',
  ah(async (req, res) => {
    const { note } = z.object({ note: z.string() }).parse(req.body);
    await addNote(req.params.id!, note, req.admin!.id);
    res.json(await orderDetail(req.params.id!));
  }),
);
