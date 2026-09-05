// src/modules/users/profiles.routes.ts

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import {
  getOwnerProfile,
  getTenantProfile,
  patchOwnerProfile,
  patchTenantProfile,
} from './profiles.controller';
import { profilePatchSchema } from './users.schemas';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function profilesRouter(): Router {
  const r = Router();

  // OWNER-only READ: the OWNER role gate is intentionally strict (no
  // ADMIN bypass here per Phase-5 decision). An ADMIN who wants to
  // read another user's owner profile uses the user-detail path
  // (GET /users/:id) instead.
  //
  // OWNER PATCH is open to ANY authenticated user so they can bootstrap
  // their profile BEFORE role activation. The service upserts keyed
  // on req.user.id, so a USER can build their owner profile, submit
  // KYC (Phase 9), and then activate OWNER — the role gate is on
  // GET, not on the bootstrap write.
  r.get('/owner', requireAuth, requireRole('OWNER'), asyncHandler(getOwnerProfile));

  r.patch(
    '/owner',
    requireAuth,
    zodValidate({ body: profilePatchSchema }),
    asyncHandler(patchOwnerProfile)
  );

  r.get('/tenant', requireAuth, requireRole('TENANT'), asyncHandler(getTenantProfile));

  r.patch(
    '/tenant',
    requireAuth,
    zodValidate({ body: profilePatchSchema }),
    asyncHandler(patchTenantProfile)
  );

  return r;
}
