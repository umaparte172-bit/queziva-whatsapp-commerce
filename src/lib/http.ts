import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 does not forward rejected promises to the error handler – this does. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
