// src/modules/applications/viewings.routes.ts
//
// Routes for /api/v1/viewings/* — mounted under /api/v1/viewings in
// server.ts.
//
// Spec §13.2.5 (Phase 12) endpoints:
//   GET    /viewings/:id             TENANT (party) or OWNER (party) → read
//   POST   /viewings/:id/confirm     OWNER (party) or ADMIN → pick slot
//   POST   /viewings/:id/cancel      TENANT (party) or OWNER (party) → cancel
//
// "Party" means: either the tenant named on the viewing, or the
// property owner of the room. ADMIN bypasses ownership. Unlike the
// standard `requireOwnership` middleware (which compares against a
// single owner id), viewings need EITHER party to pass — see
// `requireViewingParty` in viewings.controller.ts.

import { Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import {
  cancelViewingSchema,
  confirmViewingSchema,
  viewingIdParamsSchema,
} from './applications.schemas';
import {
  cancelViewingHandler,
  confirmViewingHandler,
  getViewingHandler,
  requireViewingParty,
} from './viewings.controller';

export function viewingsRouter(): Router {
  const r = Router();

  // GET /viewings/:id — either party can read.
  r.get(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: viewingIdParamsSchema }),
    requireViewingParty,
    getViewingHandler
  );

  // POST /viewings/:id/confirm — owner (party) or ADMIN.
  r.post(
    '/:id/confirm',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    requireViewingParty,
    zodValidate({
      params: viewingIdParamsSchema,
      body: confirmViewingSchema,
    }),
    confirmViewingHandler
  );

  // POST /viewings/:id/cancel — either party can cancel.
  r.post(
    '/:id/cancel',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    requireViewingParty,
    zodValidate({
      params: viewingIdParamsSchema,
      body: cancelViewingSchema,
    }),
    cancelViewingHandler
  );

  return r;
}
