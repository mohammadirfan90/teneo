// src/modules/properties/properties.routes.ts
//
// Routes for /properties/* — mounted under /api/v1/properties in server.ts.
//
// Authorization layers per spec §13.2.3 + §2.6 + §6.9:
//   - POST   /                  requireAuth + requireRole('OWNER') (KYC check in service)
//   - GET    /:id               requireAuth (any logged-in user; public-safe subset)
//   - PATCH  /:id               requireAuth + requireRole('OWNER' or 'ADMIN') (ownership in service)
//   - DELETE /:id               requireAuth + requireRole('OWNER' or 'ADMIN') (ownership in service)
//   - POST   /:id/publish       requireAuth + requireRole('OWNER') (KYC + ownership in service)
//   - GET    /me                requireAuth + requireRole('OWNER')
//
// IMPORTANT: /me must be registered BEFORE /:id so Express doesn't
// capture "me" as a UUID-shaped id.

import { type RequestHandler, Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import { createBuilding } from './buildings.controller';
import {
  createBuildingSchema,
  propertyIdParamsSchema as propertyIdPathParams,
} from './buildings.schemas';
import {
  createProperty,
  deleteProperty,
  getProperty,
  listMyProperties,
  patchProperty,
  publishProperty,
} from './properties.controller';
import {
  createPropertySchema,
  patchPropertySchema,
  propertyIdParamsSchema,
} from './properties.schemas';

export function propertiesRouter(): Router {
  const r = Router();

  // /me first — see header.
  // Query parsing happens inline in the controller (see properties.controller.ts)
  // because Express 5's req.query getter rebuilds the object on each access,
  // so a middleware-time coercion would not survive to the handler.
  r.get('/me', requireAuth, requireRole('OWNER'), asyncHandler(listMyProperties));

  r.post(
    '/',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({ body: createPropertySchema }),
    asyncHandler(createProperty)
  );

  r.get(
    '/:id',
    requireAuth,
    zodValidate({ params: propertyIdParamsSchema }),
    asyncHandler(getProperty)
  );

  r.patch(
    '/:id',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({
      params: propertyIdParamsSchema,
      body: patchPropertySchema,
    }),
    asyncHandler(patchProperty)
  );

  r.delete(
    '/:id',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({ params: propertyIdParamsSchema }),
    asyncHandler(deleteProperty)
  );

  r.post(
    '/:id/publish',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({ params: propertyIdParamsSchema }),
    asyncHandler(publishProperty)
  );

  // POST /properties/:property_id/buildings (spec §13.2.3).
  // Mounted here because the URL is properties-prefixed.
  r.post(
    '/:propertyId/buildings',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({
      params: propertyIdPathParams,
      body: createBuildingSchema,
    }),
    asyncHandler(createBuilding)
  );

  return r;
}
