// src/modules/documents/documents.service.ts
//
// Private document storage backed by Cloudinary.
//
// Replaces the Phase 18 stub, which minted `https://stub.local/…` URLs and
// persisted a row for an object that was never uploaded anywhere. The flow
// is now: multer buffers the multipart body in memory → we stream it to
// Cloudinary as an `authenticated` (private) asset → we persist the row
// with the real public_id, byte count and content type Cloudinary reports.
//
// Why server-side upload rather than a browser-direct presigned PUT:
// documents here are KYC scans and signed leases. Routing the bytes through
// the API means the MIME allowlist, the magic-byte check and the size cap
// are all enforced by code we control, and the Document row can never
// disagree with what is actually stored.
//
// Authorization model (unchanged):
//   • uploadDocument     — any authenticated user; row is owned by caller.
//   • getDownloadUrl     — owner or ADMIN.
//   • softDeleteDocument — owner or ADMIN.
//
// 404 no-leak (404 when the document does not exist; 403 when it does but
// the caller is neither owner nor admin) — mirrors the Phase 14 invoice
// and Phase 16 meter pattern.

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { Prisma as PrismaTypes } from '@/generated/prisma/client';

import {
  SIGNED_URL_TTL_SECONDS,
  destroyAsset,
  signedDeliveryUrl,
  uploadBuffer,
} from '@/lib/cloudinary';
import { prisma } from '@/lib/db';
import { ApiError, ForbiddenError, NotFoundError, ServerError } from '@/lib/errors';
import { logger } from '@/lib/logger';

// ──────────────────────────────────────────────────────────────────────
// Status enum (free-text VARCHAR(16) in the migration; closed-set here).
// ──────────────────────────────────────────────────────────────────────

export const DocumentStatus = {
  ACTIVE: 'ACTIVE',
  SOFT_DELETED: 'SOFT_DELETED',
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

/** Signed download URLs expire after 15 minutes. */
const URL_TTL_MS = SIGNED_URL_TTL_SECONDS * 1000;

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
  storageProvider: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadedDocumentView extends DocumentView {
  downloadUrl: string;
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
  storageProvider: string;
  resourceType: string;
  deliveryType: string;
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
    storageProvider: r.storageProvider,
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
    storageProvider: true,
    resourceType: true,
    deliveryType: true,
    createdAt: true,
    updatedAt: true,
  }) satisfies PrismaTypes.DocumentSelect;

// ──────────────────────────────────────────────────────────────────────
// uploadDocument — POST /documents (multipart)
// ──────────────────────────────────────────────────────────────────────

export interface UploadDocumentServiceInput {
  objectKeyPrefix: string;
  label: string | null;
  file: { buffer: Buffer; mimetype: string; size: number };
}

/**
 * Streams the buffered file to Cloudinary, then records it.
 *
 * Ordering matters: the upload happens before the INSERT so a storage
 * failure leaves no orphan row claiming an asset that does not exist. The
 * inverse leak — an uploaded asset whose INSERT then fails — is cleaned up
 * by the compensating destroy in the catch block, which is best-effort by
 * design: if that cleanup also fails we log and let the caller see the
 * original error rather than masking it.
 */
export async function uploadDocument(
  callerUserId: string,
  input: UploadDocumentServiceInput
): Promise<UploadedDocumentView> {
  const asset = await uploadBuffer(input.file.buffer, {
    folder: `documents/${input.objectKeyPrefix}/${callerUserId}`,
    // Private: KYC scans and lease PDFs must never be publicly addressable.
    deliveryType: 'authenticated',
    // `auto` so a PDF is routed to Cloudinary's `raw` bucket while images
    // keep the `image` pipeline (and its transformation support).
    resourceType: 'auto',
    publicId: randomUUID(),
  });

  let created: DocumentRow;
  try {
    created = (await prisma.document.create({
      data: {
        ownerUserId: callerUserId,
        objectKey: asset.publicId,
        contentType: input.file.mimetype,
        // Trust Cloudinary's byte count over the client's declared size.
        sizeBytes: BigInt(asset.bytes),
        label: input.label,
        status: DocumentStatus.ACTIVE,
        storageProvider: 'cloudinary',
        resourceType: asset.resourceType,
        deliveryType: asset.deliveryType,
        etag: asset.etag,
      },
      select: fullDocumentSelect(),
    })) as unknown as DocumentRow;
  } catch (err) {
    await destroyAsset({
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      deliveryType: asset.deliveryType,
    }).catch((cleanupErr) => {
      logger.error(
        { err: cleanupErr, publicId: asset.publicId },
        'document_orphan_cleanup_failed'
      );
    });
    throw err;
  }

  const signed = signedDeliveryUrl({
    publicId: created.objectKey,
    resourceType: created.resourceType,
    deliveryType: created.deliveryType,
  });

  return {
    ...documentRowToView(created),
    downloadUrl: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
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
  const row = (await prisma.document.findUnique({
    where: { id: documentId },
    select: fullDocumentSelect(),
  })) as unknown as DocumentRow | null;
  if (!row) throw new NotFoundError('Document not found');

  if (row.status === DocumentStatus.SOFT_DELETED) {
    throw new ApiError(410, 'GONE', 'Document has been deleted');
  }

  if (!isAdmin && row.ownerUserId !== callerUserId) {
    throw new ForbiddenError('NOT_OWNER', 'Caller is not the owner of this document');
  }

  // Rows minted by the pre-Cloudinary stub point at nothing. Say so
  // plainly instead of handing back a URL that will 404 at the CDN.
  if (row.storageProvider !== 'cloudinary') {
    throw new ApiError(
      410,
      'GONE',
      'Document predates real storage and has no retrievable content'
    );
  }

  const signed = signedDeliveryUrl({
    publicId: row.objectKey,
    resourceType: row.resourceType,
    deliveryType: row.deliveryType,
  });

  return {
    id: row.id,
    downloadUrl: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// softDeleteDocument — DELETE /:id
// ──────────────────────────────────────────────────────────────────────

/**
 * Flips the row to SOFT_DELETED and destroys the remote asset.
 *
 * The DB write commits first: a row marked deleted whose bytes still
 * linger is a storage-cost problem, whereas destroying the asset before
 * the commit would — if the transaction then rolled back — leave an
 * ACTIVE row pointing at nothing a user could ever fetch. Losing access
 * is recoverable; silent data loss is not.
 */
export async function softDeleteDocument(
  callerUserId: string,
  isAdmin: boolean,
  documentId: string
): Promise<DocumentView> {
  const { view, toDestroy } = await prisma.$transaction(async (tx) => {
    const row = (await tx.document.findUnique({
      where: { id: documentId },
      select: fullDocumentSelect(),
    })) as unknown as DocumentRow | null;
    if (!row) throw new NotFoundError('Document not found');

    if (!isAdmin && row.ownerUserId !== callerUserId) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not the owner of this document');
    }

    // Soft-delete is idempotent — re-deleting an already-deleted row is a
    // no-op, and must not re-issue a destroy for an asset already gone.
    if (row.status === DocumentStatus.SOFT_DELETED) {
      return { view: documentRowToView(row), toDestroy: null };
    }

    const updated = (await tx.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.SOFT_DELETED, deletedAt: new Date() },
      select: fullDocumentSelect(),
    })) as unknown as DocumentRow;

    return {
      view: documentRowToView(updated),
      toDestroy:
        updated.storageProvider === 'cloudinary'
          ? {
              publicId: updated.objectKey,
              resourceType: updated.resourceType,
              deliveryType: updated.deliveryType,
            }
          : null,
    };
  });

  if (toDestroy) {
    // Best-effort: the row is already deleted from the caller's point of
    // view, so a storage hiccup must not turn a successful DELETE into a
    // 500. Logged for the orphan-sweep job to pick up.
    await destroyAsset(toDestroy).catch((err) => {
      logger.error({ err, publicId: toDestroy.publicId }, 'document_asset_destroy_failed');
    });
  }

  return view;
}
