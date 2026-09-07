// src/modules/admin/feature-flags.routes.ts
//
// Phase 19: routes for /api/v1/admin/feature-flags/*.
//
//   GET   /
//   PUT   /:key
//
// All routes require ADMIN role.

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';

import { listFlagsHandler, upsertFlagHandler } from './feature-flags.controller';
import { flagKeyParamsSchema, upsertFlagBodySchema } from './feature-flags.controller';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function featureFlagsRouter(): Router {
  const r = Router();

  // GET /
  r.get('/', requireAuth, requireRole('ADMIN'), asyncHandler(listFlagsHandler));

  // PUT /:key
  r.put(
    '/:key',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ params: flagKeyParamsSchema }),
    zodValidate({ body: upsertFlagBodySchema }),
    withIdempotency,
    asyncHandler(upsertFlagHandler)
  );

  return r;
}
