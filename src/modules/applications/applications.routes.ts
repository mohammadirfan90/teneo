// src/modules/applications/applications.routes.ts
//
// Routes for /api/v1/applications/* — mounted under
// /api/v1/applications in server.ts.
//
// Spec §13.2.5 endpoints (Phase 12):
//   POST   /                          TENANT (KYC_APPROVED) → create
//   GET    /                          TENANT or OWNER → list (own)
//   GET    /:id                       TENANT (own), OWNER (own), ADMIN → read
//   POST   /:id/transition            OWNER (own), ADMIN → state move
//   POST   /:id/withdraw              TENANT (own) → pull application
//   POST   /:id/notes                 OWNER (own), ADMIN → owner note
//   POST   /:id/viewing               OWNER (own), ADMIN → propose slots
//
// Viewing confirm/cancel live under /api/v1/viewings (viewings.routes.ts).

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireOwnership } from '@/middleware/ownership';
import { requireRole } from '@/middleware/role';

import {
  addApplicationNoteHandler,
  createApplicationHandler,
  createViewingHandler,
  getApplicationHandler,
  listApplicationsHandler,
  transitionApplicationHandler,
  withdrawApplicationHandler,
} from './applications.controller';
import {
  addApplicationNoteSchema,
  applicationIdParamsSchema,
  createApplicationSchema,
  createViewingSchema,
  listApplicationsQuerySchema,
  transitionApplicationSchema,
  withdrawApplicationSchema,
} from './applications.schemas';
import { resolveOwnerIdForApplication } from './applications.service';

// Express 5 widens req.params values to `string | string[]`. For our
// single-segment paths the value is always a string; coerce defensively.
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

export function applicationsRouter(): Router {
  const r = Router();

  // POST /applications — tenant creates an application.
  // KYC gate lives inside the service (assertKycApprovedForTenant),
  // throwing ForbiddenError('KYC_REQUIRED') → 403.
  r.post(
    '/',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ body: createApplicationSchema }),
    asyncHandler(createApplicationHandler)
  );

  // GET /applications — list. The handler decides tenant-vs-owner shape
  // based on req.user.roles (an admin can use either; tenants see own,
  // owners see apps against their rooms).
  r.get(
    '/',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ query: listApplicationsQuerySchema }),
    asyncHandler(listApplicationsHandler)
  );

  // GET /:id — tenant (own), owner (own), admin. Ownership is the
  // application row's chain to property.ownerUserId; ADMIN bypasses
  // via middleware. Tenants who don't own the row would hit 403
  // here — but they're filtered in the service for tenant lists.
  r.get(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: applicationIdParamsSchema }),
    asyncHandler(getApplicationHandler)
  );

  // POST /:id/transition — owner or admin, ownership-checked.
  r.post(
    '/:id/transition',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    requireOwnership(async (req) => resolveOwnerIdForApplication(paramId(req, 'id'))),
    zodValidate({
      params: applicationIdParamsSchema,
      body: transitionApplicationSchema,
    }),
    asyncHandler(transitionApplicationHandler)
  );

  // POST /:id/withdraw — tenant owns the application; the service
  // re-checks tenantUserId === caller.id (so a TENANT who is also
  // OWNER can't withdraw someone else's row).
  r.post(
    '/:id/withdraw',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({
      params: applicationIdParamsSchema,
      body: withdrawApplicationSchema,
    }),
    asyncHandler(withdrawApplicationHandler)
  );

  // POST /:id/notes — owner-only free-text notes.
  r.post(
    '/:id/notes',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    requireOwnership(async (req) => resolveOwnerIdForApplication(paramId(req, 'id'))),
    zodValidate({
      params: applicationIdParamsSchema,
      body: addApplicationNoteSchema,
    }),
    asyncHandler(addApplicationNoteHandler)
  );

  // POST /:id/viewing — owner creates a viewing with proposed slots.
  r.post(
    '/:id/viewing',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    requireOwnership(async (req) => resolveOwnerIdForApplication(paramId(req, 'id'))),
    zodValidate({
      params: applicationIdParamsSchema,
      body: createViewingSchema,
    }),
    asyncHandler(createViewingHandler)
  );

  return r;
}
