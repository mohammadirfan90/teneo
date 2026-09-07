// src/modules/invoices/invoices.routes.ts
//
// Routes for /api/v1/invoices/* — mounted under /api/v1/invoices in
// server.ts.
//
// Phase 14 endpoints:
//   GET    /me                              TENANT | OWNER | ADMIN
//   GET    /:id                             party-or-admin
//   POST   /:id/waive                       ADMIN only
//   POST   /:id/dispute                     TENANT | OWNER party

import { type RequestHandler, Router } from 'express';

import { withIdempotency } from '@/middleware/idempotency';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';
import { zodValidate } from '@/lib/validate';

import {
  disputeInvoiceHandler,
  getInvoiceHandler,
  listInvoicesHandler,
  requireInvoiceParty,
  waiveInvoiceHandler,
} from './invoices.controller';
import {
  disputeInvoiceSchema,
  invoiceIdParamsSchema,
  waiveInvoiceSchema,
} from './invoices.schemas';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function invoicesRouter(): Router {
  const r = Router();

  // GET /invoices/me — caller sees own (owner OR tenant party).
  r.get(
    '/me',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    asyncHandler(listInvoicesHandler)
  );

  // GET /invoices/:id — any party or ADMIN.
  r.get(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: invoiceIdParamsSchema }),
    requireInvoiceParty,
    asyncHandler(getInvoiceHandler)
  );

  // POST /invoices/:id/waive — ADMIN only.
  r.post(
    '/:id/waive',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ params: invoiceIdParamsSchema, body: waiveInvoiceSchema }),
    withIdempotency,
    asyncHandler(waiveInvoiceHandler)
  );

  // POST /invoices/:id/dispute — TENANT or OWNER party.
  r.post(
    '/:id/dispute',
    requireAuth,
    requireRole('TENANT', 'OWNER'),
    requireInvoiceParty,
    zodValidate({ params: invoiceIdParamsSchema, body: disputeInvoiceSchema }),
    withIdempotency,
    asyncHandler(disputeInvoiceHandler)
  );

  return r;
}