// src/modules/documents/documents.controller.ts
//
// Thin handlers for /api/v1/documents/*. Storage is Cloudinary; the
// multipart body is parsed upstream by singleDocumentUpload (multer).

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { isStorageEnabled } from '@/lib/cloudinary';
import { ok } from '@/lib/envelope';
import { StorageDisabledError } from '@/lib/errors';
import { assertMagicBytes, requireFile } from '@/middleware/upload';

import {
  type DocumentIdParams,
  type UploadDocumentInput,
  toUploadDocumentFields,
} from './documents.schemas';
import { getDownloadUrl, softDeleteDocument, uploadDocument } from './documents.service';

/**
 * Fails fast with 503 when Cloudinary credentials are absent, before the
 * request touches the database. Mirrors the Stripe pre-flight in
 * payments.controller.ts so an unconfigured environment is obvious.
 */
function assertStorageEnabled(): void {
  if (!isStorageEnabled()) throw new StorageDisabledError();
}

// ──────────────────────────────────────────────────────────────────────
// POST /documents — multipart/form-data, field `file`
// ──────────────────────────────────────────────────────────────────────

export const uploadDocumentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;

  // Validate the request BEFORE checking whether storage is configured. A
  // malformed upload is a 400 whatever the server's credentials look like;
  // answering 503 first would tell the caller their own bug is our outage.
  const file = requireFile(req.file);
  // Content-Type headers are caller-supplied; verify the bytes agree
  // before anything is shipped to storage.
  assertMagicBytes(file);

  assertStorageEnabled();

  const fields = toUploadDocumentFields(req.body as UploadDocumentInput);
  const data = await uploadDocument(userId, {
    objectKeyPrefix: fields.objectKeyPrefix,
    label: fields.label,
    file: { buffer: file.buffer, mimetype: file.mimetype, size: file.size },
  });

  res.status(201).json(ok(data, 'Document uploaded'));
});

// ──────────────────────────────────────────────────────────────────────
// GET /:id/url
// ──────────────────────────────────────────────────────────────────────

export const getDownloadUrlHandler: RequestHandler = asyncHandler(async (req, res) => {
  assertStorageEnabled();

  const userId = req.user!.id;
  const isAdmin = req.user!.roles.includes('ADMIN');
  const { id } = req.params as unknown as DocumentIdParams;
  const data = await getDownloadUrl(userId, isAdmin, id);
  res.status(200).json(ok(data, 'Download URL retrieved'));
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /:id
// ──────────────────────────────────────────────────────────────────────

export const softDeleteDocumentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const isAdmin = req.user!.roles.includes('ADMIN');
  const { id } = req.params as unknown as DocumentIdParams;
  const data = await softDeleteDocument(userId, isAdmin, id);
  res.status(200).json(ok(data, 'Document deleted'));
});
