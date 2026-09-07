// src/modules/documents/documents.routes.ts
//
// Phase 18: routes for /api/v1/documents/*.
//
//   POST   /upload-url    mint a stub upload URL + persist a Document row
//   GET    /:id/url       get a stub download URL (owner or admin)
//   DELETE /:id           soft-delete (owner or admin)

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';

import {
  getDownloadUrlHandler,
  requestUploadUrlHandler,
  softDeleteDocumentHandler,
} from './documents.controller';
import { documentIdParamsSchema, requestUploadUrlSchema } from './documents.schemas';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function documentsRouter(): Router {
  const r = Router();

  // POST /upload-url — any authenticated user; row is owned by caller.
  r.post(
    '/upload-url',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ body: requestUploadUrlSchema }),
    withIdempotency,
    asyncHandler(requestUploadUrlHandler)
  );

  // GET /:id/url — owner or admin.
  r.get(
    '/:id/url',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: documentIdParamsSchema }),
    asyncHandler(getDownloadUrlHandler)
  );

  // DELETE /:id — owner or admin; soft-delete.
  r.delete(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: documentIdParamsSchema }),
    withIdempotency,
    asyncHandler(softDeleteDocumentHandler)
  );

  return r;
}
