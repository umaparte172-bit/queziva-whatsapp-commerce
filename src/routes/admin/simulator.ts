import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../../lib/http.js';
import {
  COURIER_STATUSES,
  courierUpdate,
  fastForward,
  pay,
  sendCart,
  sendText,
  simulatorState,
  submitAddress,
  tapButton,
} from '../../services/simulator.js';

/** Test-mode customer simulator (mounted only when WhatsApp runs in mock mode). */
export const simulatorRouter = Router();

const waId = z.string().regex(/^91999\d{7}$/, 'Simulator customers use numbers starting 91999 followed by 7 digits');

/** Every action responds with the refreshed simulator state. */
function action<T extends z.ZodTypeAny>(schema: T, run: (body: z.infer<T>) => Promise<unknown>) {
  return ah(async (req, res) => {
    const body = schema.parse(req.body) as z.infer<T> & { waId: string };
    await run(body);
    res.json(await simulatorState(body.waId));
  });
}

simulatorRouter.get(
  '/simulator',
  ah(async (req, res) => {
    res.json(await simulatorState(waId.parse(req.query.waId)));
  }),
);

simulatorRouter.post(
  '/simulator/cart',
  action(
    z.object({
      waId,
      name: z.string().trim().min(1).max(60),
      items: z.array(z.object({ retailerId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
    }),
    (b) => sendCart(b.waId, b.name, b.items),
  ),
);

simulatorRouter.post('/simulator/text', action(z.object({ waId, text: z.string().trim().min(1).max(1000) }), (b) => sendText(b.waId, b.text)));

simulatorRouter.post(
  '/simulator/button',
  action(z.object({ waId, id: z.string().min(1).max(256), title: z.string().max(40), onTemplate: z.boolean() }), (b) =>
    tapButton(b.waId, b.id, b.title, b.onTemplate),
  ),
);

simulatorRouter.post(
  '/simulator/address',
  action(z.object({ waId, values: z.record(z.string().max(300)) }), (b) => submitAddress(b.waId, b.values)),
);

simulatorRouter.post('/simulator/pay', action(z.object({ waId, outcome: z.enum(['captured', 'failed']) }), (b) => pay(b.waId, b.outcome)));

simulatorRouter.post('/simulator/courier', action(z.object({ waId, status: z.enum(COURIER_STATUSES) }), (b) => courierUpdate(b.waId, b.status)));

simulatorRouter.post(
  '/simulator/fast-forward',
  action(z.object({ waId, hours: z.number().min(1).max(24 * 14) }), (b) => fastForward(b.hours)),
);
