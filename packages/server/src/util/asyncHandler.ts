import type { NextFunction, Request, Response } from "express";

/**
 * Express 4 does not forward a rejected promise from an `async` route
 * handler to the error-handling middleware the way it does a synchronous
 * throw -- it just becomes an unhandled promise rejection. Since Node 15,
 * the default behavior for an unhandled rejection is to terminate the
 * process, so any route that awaits a query which can reject (a malformed
 * UUID in a path param is enough -- Postgres rejects with "invalid input
 * syntax for type uuid") could crash the whole server on a single bad
 * request. Wrap every async handler with this so its rejection is routed
 * to `next(err)`, exactly like a synchronous throw would be, and picked up
 * by the catch-all error middleware in `app.ts`.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Req, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
