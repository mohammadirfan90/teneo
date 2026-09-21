// src/modules/documents/documents.routes.ts
//
// Routes for /api/v1/documents/*.
//
//   POST   /            multipart upload → Cloudinary (private asset)
//   GET    /:id/url     short-lived signed download URL (owner or admin)
//   DELETE /:id         soft-delete row + destroy remote asset
//
// Middleware order on the upload route is load-bearing:
//   requireAuth → requireRole → multer → zodValidate(body) → idempotency
//
// multer has to run before zodValidate because `req.body` does not exist
// until the multipart stream has been parsed — validating first would see
// an empty object and reject every well-formed request. withIdempotency
// runs last because it hashes the parsed body.

import { Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';
import { singleDocumentUpload } from '@/middleware/upload';

import {
  getDownloadUrlHandler,
  softDeleteDocumentHandler,
  uploadDocumentHandler,
} from './documents.controller';
import { documentIdParamsSchema, uploadDocumentSchema } from './documents.schemas';

export function documentsRouter(): Router {
  const r = Router();

  // POST / — any authenticated user; the row is owned by the caller.
  r.post(
    '/',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    singleDocumentUpload,
    zodValidate({ body: uploadDocumentSchema }),
    withIdempotency,
    asyncHandler(uploadDocumentHandler)
  );

  // GET /:id/url — owner or admin.
  r.get(
    '/:id/url',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: documentIdParamsSchema }),
    asyncHandler(getDownloadUrlHandler)
  );

  // DELETE /:id — owner or admin; soft-delete + remote destroy.
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
