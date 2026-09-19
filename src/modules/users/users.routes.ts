// src/modules/users/users.routes.ts
//
// Routes for /users/* — mounted under /api/v1/users in server.ts.
//
// Order matters: `/me` and `/me/roles/:role/activate` must register
// before `/:id` so Express doesn't capture `me` as a user id.

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import { activateRole, deactivateUser, getMe, getUserById, updateMe } from './users.controller';
import { activateRoleParamsSchema, updateMeSchema, userIdParamsSchema } from './users.schemas';

export function usersRouter(): Router {
  const r = Router();

  r.get('/me', requireAuth, asyncHandler(getMe));

  r.patch('/me', requireAuth, zodValidate({ body: updateMeSchema }), asyncHandler(updateMe));

  r.post(
    '/me/roles/:role/activate',
    requireAuth,
    zodValidate({ params: activateRoleParamsSchema }),
    asyncHandler(activateRole)
  );

  // ADMIN-only lookups.
  r.get(
    '/:id',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ params: userIdParamsSchema }),
    asyncHandler(getUserById)
  );

  r.post(
    '/:id/deactivate',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ params: userIdParamsSchema }),
    asyncHandler(deactivateUser)
  );

  return r;
}

// Re-export so callers can wire it explicitly.
export type NextFunctionT = NextFunction;
export type RequestT = Request;
export type ResponseT = Response;
