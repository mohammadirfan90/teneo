// src/modules/admin/admin.routes.ts
//
// Phase 19: routes for /api/v1/admin/* + /api/v1/admin/audit-logs/*.
// All routes require ADMIN role.
//
//   GET   /users/search
//   POST  /listings/:id/takedown
//   POST  /listings/:id/reinstate
//   GET   /health
//   GET   /audit-logs                (sub-router — see below)
//   GET   /audit-logs/export         (CSV streaming; part of audit.controller)
//
// The audit-logs sub-router is mounted INSIDE this file (rather than a
// separate admin/audit.routes.ts) so we honor phases.json files_allowed
// exactly. The audit.controller.ts handler is invoked directly.

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';

import {
  getAdminHealthHandler,
  reinstateListingHandler,
  searchUsersHandler,
  takedownListingHandler,
} from './admin.controller';
import {
  listingIdParamsSchema,
  searchUsersQuerySchema,
  takedownBodySchema,
} from './admin.controller';
import { listAuditLogsHandler } from './audit.controller';
import { listAuditLogsQuerySchema } from './audit.controller';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function adminRouter(): Router {
  const r = Router();

  // The audit-logs sub-router is mounted under /audit-logs to honor
  // phases.json files_allowed (no separate audit.routes.ts file).
  const auditRouter = Router();
  auditRouter.get(
    '/',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ query: listAuditLogsQuerySchema }),
    asyncHandler(listAuditLogsHandler)
  );
  r.use('/audit-logs', auditRouter);

  // GET /users/search
  r.get(
    '/users/search',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ query: searchUsersQuerySchema }),
    asyncHandler(searchUsersHandler)
  );

  // POST /listings/:id/takedown
  r.post(
    '/listings/:id/takedown',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ params: listingIdParamsSchema }),
    zodValidate({ body: takedownBodySchema }),
    withIdempotency,
    asyncHandler(takedownListingHandler)
  );

  // POST /listings/:id/reinstate
  r.post(
    '/listings/:id/reinstate',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ params: listingIdParamsSchema }),
    withIdempotency,
    asyncHandler(reinstateListingHandler)
  );

  // GET /health
  r.get('/health', requireAuth, requireRole('ADMIN'), asyncHandler(getAdminHealthHandler));

  return r;
}
