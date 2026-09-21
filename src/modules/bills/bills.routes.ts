// src/modules/bills/bills.routes.ts
//
// Routes for /api/v1/bills/* — mounted under /api/v1/bills in server.ts.
//
// Phase 14: POST /generate (OWNER)
// Phase 16: + GET /me (any role) + GET /:id (party-or-admin)

import { Router } from 'express';

import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';
import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';

import {
  generateBillHandler,
  getBillHandler,
  listBillsHandler,
  requireBillParty,
} from './bills.controller';
import {
  billIdParamsSchema,
  generateBillSchema,
  listBillsQuerySchema,
} from './bills.schemas';

export function billsRouter(): Router {
  const r = Router();

  // GET /bills/me — caller-scoped list. No party check (the service
  // filters to bills the caller owns or has a share on).
  r.get(
    '/me',
    requireAuth,
    requireRole('OWNER', 'TENANT', 'ADMIN'),
    zodValidate({ query: listBillsQuerySchema }),
    asyncHandler(listBillsHandler)
  );

  // POST /bills/generate — OWNER only (extended in Phase 16 to also
  // produce utility bills + BillShares inside the same tx).
  r.post(
    '/generate',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({ body: generateBillSchema }),
    withIdempotency,
    asyncHandler(generateBillHandler)
  );

  // GET /bills/:id — bill detail with shares. Party-or-admin check.
  r.get(
    '/:id',
    requireAuth,
    requireRole('OWNER', 'TENANT', 'ADMIN'),
    zodValidate({ params: billIdParamsSchema }),
    requireBillParty,
    asyncHandler(getBillHandler)
  );

  return r;
}
