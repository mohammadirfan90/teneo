// src/modules/properties/flats.routes.ts
//
// Routes for /flats/* — mounted under /api/v1/flats in server.ts.
//
// Spec §13.2.3:
//   POST /flats/:flatId/rooms                   OWNER (own) — create a room under a flat

import { Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import { createRoom } from './rooms.controller';
import { createRoomSchema, flatIdParamsSchema } from './rooms.schemas';

export function flatsRouter(): Router {
  const r = Router();

  // POST /flats/:flatId/rooms — collection-y creation under a flat.
  r.post(
    '/:flatId/rooms',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({
      params: flatIdParamsSchema,
      body: createRoomSchema,
    }),
    asyncHandler(createRoom)
  );

  return r;
}
