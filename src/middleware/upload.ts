// src/middleware/upload.ts
//
// Multer multipart parsing for the two upload surfaces:
//
//   singlePhotoUpload    — POST /rooms/:id/photos      (field: `file`)
//   singleDocumentUpload — POST /documents             (field: `file`)
//
// Design notes:
//
//   • memoryStorage, not diskStorage. Nothing is ever written to the
//     container filesystem — the buffer goes straight to Cloudinary via
//     `upload_stream`. Render web services have an ephemeral disk, so a
//     temp file would be a liability with no upside.
//
//   • The `limits` are the real security boundary: `fileSize` caps the
//     body before it is fully read, and `files: 1` stops a caller from
//     smuggling extra parts past a single-file handler.
//
//   • `fileFilter` checks the client-declared MIME type. That is a
//     convenience gate only — a client can lie. `assertMagicBytes()`
//     re-checks the actual file signature after the buffer lands, which
//     is what actually stops a .exe renamed to .jpg.
//
//   • Multer throws its own MulterError class with codes like
//     LIMIT_FILE_SIZE. `toApiError()` maps those onto the project error
//     envelope so a 12MB upload returns a structured 413, not a 500.

import multer, { MulterError } from 'multer';
import type { RequestHandler } from 'express';

import { ApiError, ValidationError } from '@/lib/errors';

// ──────────────────────────────────────────────────────────────────────
// Limits + allowlists
// ──────────────────────────────────────────────────────────────────────

/** Room listing photos: images only, 8MB. */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Documents: images + PDF (KYC scans, signed leases), 15MB. */
export const DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
export const DOCUMENT_MIME_ALLOWLIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/**
 * Leading magic bytes per accepted MIME type. Checked against the real
 * buffer after multer hands it over, so a renamed executable claiming
 * `image/jpeg` is rejected even though its declared type passed the filter.
 */
const MAGIC_BYTES: Record<string, readonly number[][]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // RIFF....WEBP — bytes 8-11 are checked separately below.
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
};

// ──────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────

function makeSingleUpload(
  field: string,
  maxBytes: number,
  allowlist: readonly string[]
): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 12 },
    fileFilter: (_req, file, cb) => {
      if (!allowlist.includes(file.mimetype)) {
        cb(
          new ValidationError('Unsupported file type', [
            {
              field,
              code: 'UNSUPPORTED_MEDIA_TYPE',
              message: `contentType must be one of: ${allowlist.join(', ')}`,
            },
          ])
        );
        return;
      }
      cb(null, true);
    },
  }).single(field);

  // Wrap so MulterError never reaches the generic 500 branch of the
  // error handler — every failure mode gets a real status + code.
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      next(toApiError(err, field, maxBytes));
    });
  };
}

function toApiError(err: unknown, field: string, maxBytes: number): unknown {
  if (!(err instanceof MulterError)) return err;

  const megabytes = Math.round(maxBytes / (1024 * 1024));
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return new ApiError(413, 'PAYLOAD_TOO_LARGE', `File exceeds the ${megabytes}MB limit`, {
        fields: [{ field, code: 'LIMIT_FILE_SIZE', message: `max ${megabytes}MB` }],
      });
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return new ValidationError('Unexpected file upload', [
        {
          field,
          code: err.code,
          message: `send exactly one file in the "${field}" field`,
        },
      ]);
    default:
      return new ValidationError('Malformed multipart upload', [
        { field, code: err.code, message: err.message },
      ]);
  }
}

export const singlePhotoUpload = makeSingleUpload('file', PHOTO_MAX_BYTES, PHOTO_MIME_ALLOWLIST);
export const singleDocumentUpload = makeSingleUpload(
  'file',
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MIME_ALLOWLIST
);

// ──────────────────────────────────────────────────────────────────────
// Post-parse assertions (call from the controller)
// ──────────────────────────────────────────────────────────────────────

/**
 * Guarantees a file part was actually present. Multer leaves `req.file`
 * undefined when the client posts an empty multipart body, and every
 * upload controller would otherwise dereference undefined.
 */
export function requireFile(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file || !file.buffer || file.buffer.byteLength === 0) {
    throw new ValidationError('File is required', [
      { field: 'file', code: 'REQUIRED', message: 'multipart field "file" is required' },
    ]);
  }
  return file;
}

/**
 * Verifies the buffer actually starts with the signature for its declared
 * MIME type. This is the check that matters — `fileFilter` only sees the
 * Content-Type the client chose to send.
 */
export function assertMagicBytes(file: Express.Multer.File): void {
  const signatures = MAGIC_BYTES[file.mimetype];
  if (!signatures) return; // allowlist already rejected anything unknown

  const buf = file.buffer;
  const matches = signatures.some(
    (sig) => buf.length >= sig.length && sig.every((byte, i) => buf[i] === byte)
  );

  // WEBP is RIFF-framed: bytes 0-3 are "RIFF" and bytes 8-11 are "WEBP".
  // Checking only the RIFF prefix would also accept .wav and .avi.
  const webpOk =
    file.mimetype !== 'image/webp' ||
    (buf.length >= 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP');

  if (!matches || !webpOk) {
    throw new ValidationError('File content does not match its declared type', [
      {
        field: 'file',
        code: 'CONTENT_TYPE_MISMATCH',
        message: `bytes do not look like ${file.mimetype}`,
      },
    ]);
  }
}
