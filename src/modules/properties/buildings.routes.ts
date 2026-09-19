// src/modules/properties/buildings.routes.ts
//
// Routes for /buildings/* — mounted under /api/v1/buildings in server.ts.
//
// Spec §13.2.3 paths under /buildings:
//   POST /buildings/:building_id/flats       OWNER (own via building→property)
//   PATCH /buildings/:id                     OWNER (own via property)
//
// Note: POST /properties/:property_id/buildings is registered in
// properties.routes.ts because the URL is properties-prefixed.

import { type RequestHandler, Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import { patchBuilding } from './buildings.controller';
import {
  buildingIdParamsSchema as buildingPathParams,
  patchBuildingSchema,
} from './buildings.schemas';
import { createFlat } from './flats.controller';
import { buildingIdParamsSchema, createFlatSchema } from './flats.schemas';

export function buildingsRouter(): Router {
  const r = Router();

  // POST /buildings/:building_id/flats
  r.post(
    '/:buildingId/flats',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({
      params: buildingIdParamsSchema,
      body: createFlatSchema,
    }),
    asyncHandler(createFlat)
  );

  // PATCH /buildings/:id
  r.patch(
    '/:id',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({
      params: buildingPathParams,
      body: patchBuildingSchema,
    }),
    asyncHandler(patchBuilding)
  );

  return r;
}
