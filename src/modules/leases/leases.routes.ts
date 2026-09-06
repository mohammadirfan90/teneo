// src/modules/leases/leases.routes.ts
//
// Routes for /api/v1/leases/* — mounted under /api/v1/leases in
// server.ts.
//
// Spec §13.2.5 endpoints (Phase 13):
//   GET    /me                          TENANT or OWNER → own leases
//   GET    /:id                         any party (multi-party) → read
//   POST   /:id/sign                    TENANT (party) or OWNER (party) → sign
//   POST   /:id/confirm-move-in         TENANT (party) → SIGNED → ACTIVE
//   POST   /:id/terminate               TENANT (party) or OWNER (party) → ACTIVE → TERMINATED
//   GET    /:id/document                any party → mock signed URL
//   POST   /:id/amend                   TENANT or OWNER (party) → stub amendment
//   POST   /:id/amendments/:aid/sign    TENANT or OWNER (party) → sign amendment stub
//
// All transition routes layer `requireLeaseParty` on top of role gates
// so an ADMIN can read but cannot sign/terminate/confirm.

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import {
  amendmentIdParamsSchema,
  confirmMoveInSchema,
  leaseIdParamsSchema,
  proposeAmendmentSchema,
  signAmendmentSchema,
  signLeaseSchema,
  terminateLeaseSchema,
} from './leases.schemas';
import {
  confirmMoveInHandler,
  getLeaseDocumentHandler,
  getLeaseHandler,
  listLeasesHandler,
  proposeAmendmentHandler,
  requireLeaseParty,
  signAmendmentHandler,
  signLeaseHandler,
  terminateLeaseHandler,
} from './leases.controller';

// Express 5 widens req.params values to `string | string[]`. For our
// single-segment paths the value is always a string; coerce defensively
// (mirrors applications.routes.ts pattern).
function paramId(req: import('express').Request, key: string): string {
  const v = req.params[key];
  if (typeof v === 'string') return v;
  return Array.isArray(v) && v.length > 0 && typeof v[0] === 'string' ? (v[0] as string) : '';
}

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function leasesRouter(): Router {
  const r = Router();

  // GET /leases/me — caller sees own (owner OR tenant party).
  r.get(
    '/me',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    asyncHandler(listLeasesHandler)
  );

  // GET /leases/:id — any party or ADMIN.
  r.get(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: leaseIdParamsSchema }),
    requireLeaseParty,
    asyncHandler(getLeaseHandler)
  );

  // POST /leases/:id/sign — TENANT or OWNER party. ADMIN cannot sign.
  r.post(
    '/:id/sign',
    requireAuth,
    requireRole('TENANT', 'OWNER'),
    requireLeaseParty,
    zodValidate({
      params: leaseIdParamsSchema,
      body: signLeaseSchema,
    }),
    asyncHandler(signLeaseHandler)
  );

  // POST /leases/:id/confirm-move-in — TENANT party only.
  r.post(
    '/:id/confirm-move-in',
    requireAuth,
    requireRole('TENANT'),
    requireLeaseParty,
    zodValidate({
      params: leaseIdParamsSchema,
      body: confirmMoveInSchema,
    }),
    asyncHandler(confirmMoveInHandler)
  );

  // POST /leases/:id/terminate — TENANT or OWNER party.
  r.post(
    '/:id/terminate',
    requireAuth,
    requireRole('TENANT', 'OWNER'),
    requireLeaseParty,
    zodValidate({
      params: leaseIdParamsSchema,
      body: terminateLeaseSchema,
    }),
    asyncHandler(terminateLeaseHandler)
  );

  // GET /leases/:id/document — any party or ADMIN.
  r.get(
    '/:id/document',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: leaseIdParamsSchema }),
    requireLeaseParty,
    asyncHandler(getLeaseDocumentHandler)
  );

  // POST /leases/:id/amend — TENANT or OWNER party.
  r.post(
    '/:id/amend',
    requireAuth,
    requireRole('TENANT', 'OWNER'),
    requireLeaseParty,
    zodValidate({
      params: leaseIdParamsSchema,
      body: proposeAmendmentSchema,
    }),
    asyncHandler(proposeAmendmentHandler)
  );

  // POST /leases/:id/amendments/:aid/sign — TENANT or OWNER party.
  r.post(
    '/:id/amendments/:aid/sign',
    requireAuth,
    requireRole('TENANT', 'OWNER'),
    requireLeaseParty,
    zodValidate({
      params: amendmentIdParamsSchema,
      body: signAmendmentSchema,
    }),
    asyncHandler(signAmendmentHandler)
  );

  return r;
}
