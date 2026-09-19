// src/modules/documents/documents.schemas.ts
//
// Zod schemas for /api/v1/documents/* (04 §4.3.7, 13 §13.2.8).
//
// Endpoints:
//   POST   /documents      uploadDocument      (multipart/form-data)
//   GET    /:id/url        getDownloadUrl
//   DELETE /:id            softDeleteDocument
//
// The upload is multipart, so the file itself is validated by
// src/middleware/upload.ts (size cap, MIME allowlist, magic-byte check)
// rather than by Zod — a Buffer is not something Zod should parse. What
// remains for Zod is the accompanying text fields, which arrive as raw
// strings because multipart carries no types.

import { z } from 'zod';

import type { DocumentStatus } from './documents.service';

// ──────────────────────────────────────────────────────────────────────
// Path / query params
// ──────────────────────────────────────────────────────────────────────

export const documentIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'id must be a UUID' }),
});
export type DocumentIdParams = z.infer<typeof documentIdParamsSchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /documents — multipart text fields
// ──────────────────────────────────────────────────────────────────────

/**
 * `objectKeyPrefix` namespaces the asset inside the Cloudinary folder
 * tree, e.g. `kyc` → `teneo/documents/kyc/{userId}/{uuid}`. It is
 * regex-bounded because it is interpolated into a storage path: a `..`
 * or a leading `/` would let a caller write outside their own namespace.
 *
 * Note `.strict()` is deliberately NOT used here. Multipart parsers add
 * their own bookkeeping fields, and rejecting unknown keys would make
 * ordinary form posts fail for reasons the caller cannot see.
 */
export const uploadDocumentSchema = z.object({
  objectKeyPrefix: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_\-/]+$/, 'prefix must be a safe path segment')
    .refine((v) => !v.includes('..') && !v.startsWith('/') && !v.endsWith('/'), {
      message: 'prefix must not traverse or begin/end with a separator',
    })
    .optional(),
  label: z.string().min(1).max(200).optional(),
});
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

export interface UploadDocumentTextFields {
  objectKeyPrefix: string;
  label: string | null;
}

export function toUploadDocumentFields(body: UploadDocumentInput): UploadDocumentTextFields {
  return {
    objectKeyPrefix: body.objectKeyPrefix ?? 'user-uploads',
    label: body.label ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Status enum (lives in the service file because the migration uses a
// free-text VARCHAR(16) — the values there are the only legal ones).
// Re-exported here for controllers that want the type.
// ──────────────────────────────────────────────────────────────────────

export type { DocumentStatus };
