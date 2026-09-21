// src/modules/users/preferences.routes.ts

import { Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import { getPreferences, patchVisibility, putPreferences } from './preferences.controller';
import { preferencesPutSchema, preferencesVisibilitySchema } from './users.schemas';

export function preferencesRouter(): Router {
  const r = Router();

  // TENANT-only: gated on role so the bootstrap flow stays
  //   USER → /profiles/tenant → KYC → activate TENANT → /preferences/tenant
  // Activation only needs profile + KYC approval; preferences are
  // set after the user is a TENANT.
  r.get('/tenant', requireAuth, requireRole('TENANT'), asyncHandler(getPreferences));

  r.put(
    '/tenant',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ body: preferencesPutSchema }),
    asyncHandler(putPreferences)
  );

  r.patch(
    '/tenant/visibility',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ body: preferencesVisibilitySchema }),
    asyncHandler(patchVisibility)
  );

  return r;
}
