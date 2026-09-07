// src/modules/documents/documents.controller.ts
//
// Phase 18: thin handlers for /api/v1/documents/*. Stubbed URLs.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ok } from '@/lib/envelope';

import {
  type DocumentIdParams,
  type RequestUploadUrlInput,
  toRequestUploadUrlServiceInput,
} from './documents.schemas';
import { getDownloadUrl, requestUploadUrl, softDeleteDocument } from './documents.service';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /upload-url
// ──────────────────────────────────────────────────────────────────────

export const requestUploadUrlHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as RequestUploadUrlInput;
  const serviceInput = toRequestUploadUrlServiceInput(body);
  const data = await requestUploadUrl(userId, serviceInput);
  res.status(201).json(ok(data, 'Upload URL created'));
});

// ──────────────────────────────────────────────────────────────────────
// GET /:id/url
// ──────────────────────────────────────────────────────────────────────

export const getDownloadUrlHandler: RequestHandler = asyncHandler(async (req, res) => {
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
