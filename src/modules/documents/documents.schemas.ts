// src/modules/documents/documents.schemas.ts
//
// Zod schemas for /api/v1/documents/* per Phase 18 (04 §4.3.7,
// 13 §13.2.8). All endpoints are stubs returning mock S3 URLs.
//
// Endpoints:
//   POST  /upload-url      requestUploadUrl
//   GET   /:id/url         getDownloadUrl
//   DELETE /:id            softDeleteDocument

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
// POST /upload-url — body
// ──────────────────────────────────────────────────────────────────────

/**
 * Mints an upload URL and creates a Document row. The body validates
 * the caller is sending sane metadata; size is enforced as a positive
 * integer so the BigInt column never receives garbage.
 *
 * `objectKeyPrefix` is optional — defaults to `user-uploads`. Used
 * by other modules (Phase 19+) to namespace their documents, e.g.,
 * `kyc/{userId}` or `leases/{leaseId}`.
 */
export const requestUploadUrlSchema = z
  .object({
    objectKeyPrefix: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9_\-/]+$/, 'prefix must be a safe path segment')
      .optional(),
    contentType: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[\w.-]+\/[\w.+-]+$/, 'contentType must look like MIME/type'),
    sizeBytes: z
      .number()
      .int()
      .positive('sizeBytes must be positive')
      .max(100 * 1024 * 1024, 'sizeBytes exceeds 100MB limit'),
    label: z.string().min(1).max(200).optional(),
  })
  .strict();
export type RequestUploadUrlInput = z.infer<typeof requestUploadUrlSchema>;

export interface RequestUploadUrlServiceInput {
  objectKeyPrefix: string;
  contentType: string;
  sizeBytes: bigint;
  label: string | null;
}

export function toRequestUploadUrlServiceInput(
  body: RequestUploadUrlInput
): RequestUploadUrlServiceInput {
  return {
    objectKeyPrefix: body.objectKeyPrefix ?? 'user-uploads',
    contentType: body.contentType,
    sizeBytes: BigInt(body.sizeBytes),
    label: body.label ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Status enum (lives in the service file because the migration uses a
// free-text VARCHAR(16) — the values here are the only legal ones).
// Re-exported here for controllers that want the type.
// ──────────────────────────────────────────────────────────────────────

export type { DocumentStatus };
