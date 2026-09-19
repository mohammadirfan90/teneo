// src/lib/cloudinary.ts
//
// Cloudinary storage adapter. Replaces the Phase 18 `https://stub.local/…`
// placeholders with real object storage.
//
// Two delivery models, chosen per call-site:
//
//   type: 'upload'        — public CDN asset. Used for ROOM PHOTOS, which
//                           are marketing images on a published listing and
//                           are meant to be fetched by anonymous browsers.
//   type: 'authenticated' — private asset. Used for DOCUMENTS (KYC scans,
//                           lease PDFs, ID photos). These are never publicly
//                           readable; `signedDeliveryUrl()` mints a
//                           short-lived signed URL that Cloudinary stops
//                           honoring once `expires_at` passes.
//
// Configuration is optional at boot, exactly like src/lib/stripe.ts: when
// CLOUDINARY_* is unset the module reports `isStorageEnabled() === false`
// and upload routes return 503 STORAGE_DISABLED rather than crashing the
// process. That keeps `npm run dev` usable without credentials.

import { v2 as cloudinary } from 'cloudinary';

import { env } from '@/lib/env';
import { ServerError } from '@/lib/errors';

type CloudinaryClient = typeof cloudinary;
type GlobalWithCloudinary = typeof globalThis & { __cloudinary?: CloudinaryClient | null };
const g = globalThis as GlobalWithCloudinary;

/// Signed document URLs live 15 minutes — mirrors the TTL the Phase 18
/// stub advertised, so the client contract is unchanged.
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

/**
 * Returns the configured Cloudinary SDK, or null when credentials are
 * absent (demo mode). Cached on globalThis so `tsx watch` reloads do not
 * re-run `config()` — same pattern as src/lib/redis.ts and stripe.ts.
 */
export function getCloudinaryClient(): CloudinaryClient | null {
  if (g.__cloudinary !== undefined) return g.__cloudinary;

  const cloudName = env.CLOUDINARY_CLOUD_NAME.trim();
  const apiKey = env.CLOUDINARY_API_KEY.trim();
  const apiSecret = env.CLOUDINARY_API_SECRET.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    g.__cloudinary = null;
    return null;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  g.__cloudinary = cloudinary;
  return g.__cloudinary;
}

/** True iff Cloudinary credentials are present. Cheap pre-flight for routes. */
export function isStorageEnabled(): boolean {
  return getCloudinaryClient() !== null;
}

/** Root folder every asset is namespaced under, e.g. `teneo`. */
export function storageFolder(): string {
  return env.CLOUDINARY_FOLDER.trim() || 'teneo';
}

// ──────────────────────────────────────────────────────────────────────
// Upload
// ──────────────────────────────────────────────────────────────────────

export interface UploadOptions {
  /** Folder under the root, e.g. `rooms/<roomId>` or `documents/<userId>`. */
  folder: string;
  /** 'upload' = public CDN; 'authenticated' = private + signed delivery. */
  deliveryType: 'upload' | 'authenticated';
  /** 'image' for photos; 'auto' lets Cloudinary route PDFs to `raw`/`image`. */
  resourceType: 'image' | 'auto';
  /** Deterministic id (no extension). Collision-free per upload. */
  publicId: string;
}

export interface StoredAsset {
  publicId: string;
  secureUrl: string;
  resourceType: string;
  deliveryType: string;
  bytes: number;
  format: string | null;
  width: number | null;
  height: number | null;
  etag: string | null;
}

/**
 * Streams an in-memory buffer (multer memoryStorage) to Cloudinary.
 *
 * `upload_stream` is used rather than the base64 `upload()` path because
 * it avoids a ~33% memory blow-up on every request and lets Cloudinary
 * start hashing before the whole body is re-encoded.
 *
 * `overwrite: false` plus a UUID public_id means a retried request can
 * never clobber a previously stored asset.
 */
export async function uploadBuffer(buffer: Buffer, opts: UploadOptions): Promise<StoredAsset> {
  const client = getCloudinaryClient();
  if (!client) throw new ServerError('Cloudinary is not configured');

  const asset = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const stream = client.uploader.upload_stream(
      {
        folder: `${storageFolder()}/${opts.folder}`,
        public_id: opts.publicId,
        resource_type: opts.resourceType,
        type: opts.deliveryType,
        overwrite: false,
        // The public_id we pass is already a UUID, so neither of these
        // should ever contribute to the stored name.
        unique_filename: false,
        use_filename: false,
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error('cloudinary_empty_result'));
        resolve(result as unknown as Record<string, unknown>);
      }
    );
    stream.end(buffer);
  });

  return {
    publicId: String(asset.public_id),
    secureUrl: String(asset.secure_url),
    resourceType: String(asset.resource_type ?? 'image'),
    deliveryType: String(asset.type ?? opts.deliveryType),
    bytes: Number(asset.bytes ?? buffer.byteLength),
    format: asset.format ? String(asset.format) : null,
    width: typeof asset.width === 'number' ? asset.width : null,
    height: typeof asset.height === 'number' ? asset.height : null,
    etag: asset.etag ? String(asset.etag) : null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Delivery
// ──────────────────────────────────────────────────────────────────────

export interface SignedUrlInput {
  publicId: string;
  resourceType: string;
  deliveryType: string;
  ttlSeconds?: number;
}

/**
 * Mints a signed, expiring delivery URL for a private asset.
 *
 * Cloudinary encodes `expires_at` into the signature, so the URL stops
 * resolving on its own — there is no server-side revocation list to keep.
 * Public (`type: 'upload'`) assets need no signature, so we return the
 * plain CDN URL and skip the signing work for listing photos.
 */
export function signedDeliveryUrl(input: SignedUrlInput): { url: string; expiresAt: Date } {
  const client = getCloudinaryClient();
  if (!client) throw new ServerError('Cloudinary is not configured');

  const ttl = input.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const isPrivate = input.deliveryType === 'authenticated';

  const url = client.url(input.publicId, {
    resource_type: input.resourceType,
    type: input.deliveryType,
    secure: true,
    sign_url: isPrivate,
    ...(isPrivate ? { expires_at: Math.floor(expiresAt.getTime() / 1000) } : {}),
  });

  return { url, expiresAt };
}

// ──────────────────────────────────────────────────────────────────────
// Deletion
// ──────────────────────────────────────────────────────────────────────

/**
 * Permanently destroys a stored asset.
 *
 * Returns true when Cloudinary reports `ok` or `not found` — a missing
 * remote object is a successful outcome for a delete, and treating it as
 * an error would make our DELETE endpoints non-idempotent. Any other
 * failure is surfaced so the caller can decide whether to roll back.
 */
export async function destroyAsset(input: {
  publicId: string;
  resourceType: string;
  deliveryType: string;
}): Promise<boolean> {
  const client = getCloudinaryClient();
  if (!client) throw new ServerError('Cloudinary is not configured');

  const result = (await client.uploader.destroy(input.publicId, {
    resource_type: input.resourceType,
    type: input.deliveryType,
    invalidate: true,
  })) as { result?: string };

  const outcome = result.result ?? '';
  return outcome === 'ok' || outcome === 'not found';
}
