// src/modules/bills/meters.routes.ts
//
// Routes for /api/v1/properties/:propertyId/meters.
//
// Mounted in server.ts under `/api/v1/properties`, so the router's
// paths are relative to that prefix.
//
//   POST /:propertyId/meters    OWNER | ADMIN    requirePropertyOwner
//   GET  /:propertyId/meters    OWNER | ADMIN    requirePropertyOwner

import { Router } from 'express';

import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';
import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';

import {
  createMeterHandler,
  listMetersHandler,
  requirePropertyOwner,
} from './meters.controller';
import { createMeterSchema, propertyIdParamsSchema } from './meters.schemas';

export function metersRouter(): Router {
  const r = Router({ mergeParams: true });

  r.post(
    '/:propertyId/meters',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({ params: propertyIdParamsSchema }),
    requirePropertyOwner,
    zodValidate({ body: createMeterSchema }),
    withIdempotency,
    asyncHandler(createMeterHandler)
  );

  r.get(
    '/:propertyId/meters',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({ params: propertyIdParamsSchema }),
    requirePropertyOwner,
    asyncHandler(listMetersHandler)
  );

  return r;
}
