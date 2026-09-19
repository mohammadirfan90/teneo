// src/lib/async-handler.ts
//
// One `asyncHandler` for every route and controller.
//
// This replaces 36 local copies that had drifted into two incompatible
// shapes:
//
//   A (22 files)  (fn: RequestHandler) => Promise.resolve(fn(...)).catch(next)
//   B (14 files)  (fn: (…) => Promise<unknown>) => fn(...).catch(next)
//
// Variant B calls `.catch` on the return value directly, so handing it a
// handler that returns void — a plain synchronous one — would throw
// "Cannot read properties of undefined". Variant A tolerated that because
// `Promise.resolve(undefined)` is a promise. The shared version below
// takes A's safer form, so it accepts both sync and async handlers.
//
// It also closes a hole both variants shared: neither caught a *synchronous*
// throw, because `fn(...)` is evaluated before `Promise.resolve` ever sees
// it. Express 5 does forward sync throws on its own, so this was not an
// active bug, but relying on that made the wrapper's contract ambiguous.
// The try/catch here makes it explicit and total.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps a route handler so that a rejected promise — or a synchronous
 * throw — is forwarded to `next()` and lands in the error-handler
 * middleware, rather than surfacing as an unhandled rejection.
 *
 * Accepts handlers returning anything: `void`, a value, or a promise.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown
): RequestHandler {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}
