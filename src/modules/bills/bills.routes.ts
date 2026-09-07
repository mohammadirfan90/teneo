// src/modules/bills/bills.routes.ts
//
// Routes for /api/v1/bills/* — mounted under /api/v1/bills in server.ts.
//
// Phase 14 endpoints:
//   POST /generate                          OWNER
//
// Phase 16 will add: GET /me, GET /:id.

import { type RequestHandler, Router } from 'express';

import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';
import { zodValidate } from '@/lib/validate';

import { generateBillHandler } from './bills.controller';
import { generateBillSchema } from './bills.schemas';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function billsRouter(): Router {
  const r = Router();

  // POST /bills/generate — OWNER only.
  r.post(
    '/generate',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({ body: generateBillSchema }),
    withIdempotency,
    asyncHandler(generateBillHandler)
  );

  return r;
}