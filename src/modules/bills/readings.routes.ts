// src/modules/bills/readings.routes.ts
//
// Routes for /api/v1/meters/:meterId/readings. Mounted under
// /api/v1/meters in server.ts so the router's paths are relative.
//
//   POST /:meterId/readings      OWNER | TENANT | ADMIN    requireMeterParty
//   GET  /:meterId/readings      OWNER | TENANT | ADMIN    requireMeterParty

import { Router } from 'express';

import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';
import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';

import {
  createReadingHandler,
  listReadingsHandler,
  requireMeterParty,
} from './readings.controller';
import {
  createReadingSchema,
  listReadingsQuerySchema,
  meterIdParamsSchema,
} from './readings.schemas';

export function readingsRouter(): Router {
  const r = Router({ mergeParams: true });

  r.post(
    '/:meterId/readings',
    requireAuth,
    requireRole('OWNER', 'TENANT', 'ADMIN'),
    zodValidate({ params: meterIdParamsSchema }),
    requireMeterParty,
    zodValidate({ body: createReadingSchema }),
    withIdempotency,
    asyncHandler(createReadingHandler)
  );

  r.get(
    '/:meterId/readings',
    requireAuth,
    requireRole('OWNER', 'TENANT', 'ADMIN'),
    zodValidate({ params: meterIdParamsSchema }),
    zodValidate({ query: listReadingsQuerySchema }),
    requireMeterParty,
    asyncHandler(listReadingsHandler)
  );

  return r;
}
