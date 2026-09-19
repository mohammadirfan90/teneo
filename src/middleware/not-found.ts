// src/middleware/not-found.ts
//
// Catch-all 404 handler. Must be mounted AFTER all routes so unmatched
// requests fall through to this middleware.
//
// Emits the standard error envelope per spec §13.1.

import type { RequestHandler } from 'express';

import { fail } from '@/lib/envelope';
import { NotFoundError } from '@/lib/errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}`));
};
