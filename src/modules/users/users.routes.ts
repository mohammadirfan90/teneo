// src/modules/users/users.routes.ts
//
// Routes for /users/* — mounted under /api/v1/users in server.ts.
//
// Self-service only. ADMIN-only lookups (`GET /users/:id`,
// `POST /users/:id/deactivate`) live on adminRouter at /admin/users/:id.

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

import { getMe, updateMe } from './users.controller';
import { updateMeSchema } from './users.schemas';

export function usersRouter(): Router {
  const r = Router();

  r.get('/me', requireAuth, asyncHandler(getMe));

  r.patch('/me', requireAuth, zodValidate({ body: updateMeSchema }), asyncHandler(updateMe));

  return r;
}

// Re-export so callers can wire it explicitly.
export type NextFunctionT = NextFunction;
export type RequestT = Request;
export type ResponseT = Response;
