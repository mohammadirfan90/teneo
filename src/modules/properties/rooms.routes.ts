// src/modules/properties/rooms.routes.ts
//
// Routes for /rooms/* — mounted under /api/v1/rooms in server.ts.
//
// Spec §13.2.3:
//   GET    /rooms/:id                              public-safe (any logged-in)
//   PATCH  /rooms/:id                              OWNER (own)
//   POST   /rooms/:id/publish                      OWNER (own) + KYC
//   POST   /rooms/:id/transition                   OWNER (own) / ADMIN
//   POST   /rooms/:id/photos                       OWNER (own) — stub
//   DELETE /rooms/:id/photos/:photo_id             OWNER (own) — 501 stub
//   POST   /rooms/:id/photos/:photo_id/reorder     OWNER (own) — 501 stub
//
// Note: POST /flats/:flat_id/rooms is registered here too because
// it's rooms-shaped (the URL prefix is /rooms for collection-y ops
// and /flats/:id/rooms for creation under a flat).

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import {
  createRoom,
  deletePhoto,
  getRoom,
  patchRoom,
  publishRoom,
  reorderPhoto,
  requestPhotoUpload,
  transitionRoom,
} from './rooms.controller';
import {
  flatIdParamsSchema,
  patchRoomSchema,
  photoIdParamsSchema,
  requestPhotoUploadSchema,
  roomIdParamsSchema,
  transitionRoomSchema,
} from './rooms.schemas';
import { createRoomSchema } from './rooms.schemas';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function roomsRouter(): Router {
  const r = Router();

  // POST /flats/:flat_id/rooms — collection-y creation.
  r.post(
    '/flats/:flatId/rooms',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({
      params: flatIdParamsSchema,
      body: createRoomSchema,
    }),
    asyncHandler(createRoom)
  );

  r.get('/:id', requireAuth, zodValidate({ params: roomIdParamsSchema }), asyncHandler(getRoom));

  r.patch(
    '/:id',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({
      params: roomIdParamsSchema,
      body: patchRoomSchema,
    }),
    asyncHandler(patchRoom)
  );

  r.post(
    '/:id/publish',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({ params: roomIdParamsSchema }),
    asyncHandler(publishRoom)
  );

  r.post(
    '/:id/transition',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({
      params: roomIdParamsSchema,
      body: transitionRoomSchema,
    }),
    asyncHandler(transitionRoom)
  );

  r.post(
    '/:id/photos',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({
      params: roomIdParamsSchema,
      body: requestPhotoUploadSchema,
    }),
    asyncHandler(requestPhotoUpload)
  );

  r.delete(
    '/:id/photos/:photoId',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({ params: photoIdParamsSchema }),
    asyncHandler(deletePhoto)
  );

  r.post(
    '/:id/photos/:photoId/reorder',
    requireAuth,
    requireRole('OWNER'),
    zodValidate({ params: photoIdParamsSchema }),
    asyncHandler(reorderPhoto)
  );

  return r;
}
