// src/modules/documents/documents.service.ts
//
// Phase 18: stubbed document upload/download URLs + soft-delete.
//
// Phase 18 returns `https://stub.local/...` URLs that expire in 15
// minutes — no S3, no real upload verification. Phase 19+ replaces
// with real S3 / R2 signed URLs and a finalize callback.
//
// Authorization model:
//   • requestUploadUrl     — any authenticated user; row is owned by caller.
//   • getDownloadUrl       — owner or ADMIN.
//   • softDeleteDocument   — owner or ADMIN.
//
// 404 no-leak (404 when document doesn't exist; 403 when it does but
// the caller isn't the owner/admin) — mirrors the Phase 14 invoice +
// Phase 16 meter pattern.

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { Prisma as PrismaTypes } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { ApiError, ForbiddenError, NotFoundError } from '@/lib/errors';

// ──────────────────────────────────────────────────────────────────────
// Status enum (free-text VARCHAR(16) in the migration; closed-set here).
// ──────────────────────────────────────────────────────────────────────

export const DocumentStatus = {
  ACTIVE: 'ACTIVE',
  SOFT_DELETED: 'SOFT_DELETED',
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

// 15-minute expiry mirrors Phase 10's `requestPhotoUpload`.
const URL_TTL_MS = 15 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface DocumentView {
  id: string;
  ownerUserId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: string; // BigInt stringified to preserve precision
  label: string | null;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UploadUrlView {
  id: string;
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
}

export interface DownloadUrlView {
  id: string;
  downloadUrl: string;
  expiresAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Internal row type + mapper
// ──────────────────────────────────────────────────────────────────────

type DocumentRow = {
  id: string;
  ownerUserId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: bigint;
  label: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function documentRowToView(r: DocumentRow): DocumentView {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    objectKey: r.objectKey,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes.toString(),
    label: r.label,
    status: r.status as DocumentStatus,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const fullDocumentSelect = () =>
  ({
    id: true,
    ownerUserId: true,
    objectKey: true,
    contentType: true,
    sizeBytes: true,
    label: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  }) satisfies PrismaTypes.DocumentSelect;

// ──────────────────────────────────────────────────────────────────────
// requestUploadUrl — POST /upload-url
// ──────────────────────────────────────────────────────────────────────

export interface RequestUploadUrlServiceInput {
  objectKeyPrefix: string;
  contentType: string;
  sizeBytes: bigint;
  label: string | null;
}

/**
 * Mint a stub upload URL + persist a Document row. The object_key
 * combines the caller's prefix with a UUID and an extension inferred
 * from contentType so KYC documents, room photos, lease contracts,
 * etc. can all coexist in one bucket without collisions.
 */
export async function requestUploadUrl(
  callerUserId: string,
  input: RequestUploadUrlServiceInput
): Promise<UploadUrlView> {
  const ext =
    input.contentType
      .split('/')[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'bin';
  const objectKey = `${input.objectKeyPrefix}/${callerUserId}/${randomUUID()}.${ext}`;
  const expiresAt = new Date(Date.now() + URL_TTL_MS);

  const created = await prisma.document.create({
    data: {
      ownerUserId: callerUserId,
      objectKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      label: input.label,
      status: DocumentStatus.ACTIVE,
    },
    select: { id: true, objectKey: true },
  });

  return {
    id: created.id,
    uploadUrl: `https://stub.local/${created.objectKey}?expires=${expiresAt.getTime()}`,
    objectKey: created.objectKey,
    expiresAt: expiresAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// getDownloadUrl — GET /:id/url
// ──────────────────────────────────────────────────────────────────────

export async function getDownloadUrl(
  callerUserId: string,
  isAdmin: boolean,
  documentId: string
): Promise<DownloadUrlView> {
  const row = await prisma.document.findUnique({
    where: { id: documentId },
    select: fullDocumentSelect(),
  });
  if (!row) throw new NotFoundError('Document not found');

  if (row.status === DocumentStatus.SOFT_DELETED) {
    throw new ApiError(410, 'GONE', 'Document has been deleted');
  }

  if (!isAdmin && row.ownerUserId !== callerUserId) {
    throw new ForbiddenError('NOT_OWNER', 'Caller is not the owner of this document');
  }

  const expiresAt = new Date(Date.now() + URL_TTL_MS);
  return {
    id: row.id,
    downloadUrl: `https://stub.local/${row.objectKey}?expires=${expiresAt.getTime()}`,
    expiresAt: expiresAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// softDeleteDocument — DELETE /:id
// ──────────────────────────────────────────────────────────────────────

export async function softDeleteDocument(
  callerUserId: string,
  isAdmin: boolean,
  documentId: string
): Promise<DocumentView> {
  return await prisma.$transaction(async (tx) => {
    const row = await tx.document.findUnique({
      where: { id: documentId },
      select: fullDocumentSelect(),
    });
    if (!row) throw new NotFoundError('Document not found');

    if (!isAdmin && row.ownerUserId !== callerUserId) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not the owner of this document');
    }

    // Soft-delete is idempotent — re-deleting an already-deleted row
    // is a no-op (still returns the view).
    if (row.status === DocumentStatus.SOFT_DELETED) {
      return documentRowToView(row as unknown as DocumentRow);
    }

    const updated = await tx.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.SOFT_DELETED, deletedAt: new Date() },
      select: fullDocumentSelect(),
    });
    return documentRowToView(updated as unknown as DocumentRow);
  });
}

// Re-export the input helper for tests / callers.
export { URL_TTL_MS as DOCUMENT_URL_TTL_MS };
export type { Prisma };
