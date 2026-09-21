// src/modules/properties/rooms.routes.ts
//
// Routes for /rooms/* — mounted under /api/v1/rooms in server.ts.
//
// Spec §13.2.3:
//   GET    /rooms/:id                              public-safe (any logged-in)
//   PATCH  /rooms/:id                              OWNER (own)
//   POST   /rooms/:id/publish                      OWNER (own) + KYC
//   POST   /rooms/:id/transition                   OWNER (own) / ADMIN
//   POST   /rooms/:id/photos                       OWNER (own) — multipart upload
//   GET    /rooms/:id/photos                       any authenticated caller
//   DELETE /rooms/:id/photos/:photo_id             OWNER (own) — delete + destroy
//   POST   /rooms/:id/photos/:photo_id/reorder     OWNER (own) — gallery order
//
// Note: POST /flats/:flatId/rooms is registered on flatsRouter (see
// flats.routes.ts); only /rooms/:id/* lives here.

import { type RequestHandler, Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';
import { singlePhotoUpload } from '@/middleware/upload';

import {
  deletePhoto,
  getRoom,
  listPhotos,
  patchRoom,
  publishRoom,
  reorderPhoto,
  transitionRoom,
  uploadPhoto,
} from './rooms.controller';
import {
  patchRoomSchema,
  photoIdParamsSchema,
  reorderPhotoSchema,
  roomIdParamsSchema,
  transitionRoomSchema,
  uploadPhotoSchema,
} from './rooms.schemas';

export function roomsRouter(): Router {
  const r = Router();

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

  // multer runs before zodValidate: `req.body` does not exist until the
  // multipart stream is parsed, so validating first would see {} and
  // reject every well-formed upload.
  r.post(
    '/:id/photos',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    singlePhotoUpload,
    zodValidate({
      params: roomIdParamsSchema,
      body: uploadPhotoSchema,
    }),
    asyncHandler(uploadPhoto)
  );

  // Gallery read is open to any authenticated caller — a tenant browsing
  // a published listing needs the photos, and ownership is not required
  // to look at a listing that is already public.
  r.get(
    '/:id/photos',
    requireAuth,
    zodValidate({ params: roomIdParamsSchema }),
    asyncHandler(listPhotos)
  );

  r.delete(
    '/:id/photos/:photoId',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({ params: photoIdParamsSchema }),
    asyncHandler(deletePhoto)
  );

  r.post(
    '/:id/photos/:photoId/reorder',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({ params: photoIdParamsSchema, body: reorderPhotoSchema }),
    asyncHandler(reorderPhoto)
  );

  return r;
}
