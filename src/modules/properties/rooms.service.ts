// src/modules/properties/rooms.service.ts
//
// Business logic for /rooms/* per spec §13.2.3 + 05 §5.4 (room state
// machine) + 05 §6 (optimistic concurrency via `version`).
//
// Surfaces:
// GET /rooms/:id public-safe if not owner/admin
// PATCH /rooms/:id OWNER (own via property)
// POST /rooms/:id/publish OWNER (own) + KYC_APPROVED — DRAFT→PUBLISHED
// POST /rooms/:id/transition OWNER (own) / ADMIN — explicit transition
// POST /rooms/:id/photos OWNER (own) — multipart → Cloudinary
// DELETE /rooms/:id/photos/:photo_id OWNER (own) — soft-delete + destroy
// POST /rooms/:id/photos/:photo_id/reorder OWNER (own) — gallery order
//
// Atomicity: every state transition (publish + transition) runs the
// row update inside a `prisma.$transaction` along with audit_log and
// (for publish) audit events. Optimistic concurrency: UPDATE WHERE
// id=? AND version=? — 0 rows affected → 409 STATE_MACHINE.

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { RoomStatus, RoomType } from '@/generated/prisma/enums';

import { destroyAsset, uploadBuffer } from '@/lib/cloudinary';
import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import {
  assertCallerOwnsOrAdmin,
  assertKycApprovedForOwner,
  resolveOwnerIdForRoom,
} from './properties.service';
import type {
  CreateRoomInput,
  PatchRoomInput,
  TransitionRoomInput,
  UploadPhotoInput,
} from './rooms.schemas';
import { isValidTransition } from './rooms.state-machine';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface RoomView {
  id: string;
  propertyId: string;
  flatId: string | null;
  label: string;
  roomType: RoomType;
  sizeSqft: string | null;
  maxOccupants: number;
  baseRentMinor: string;
  depositMinor: string;
  currency: string;
  billsIncluded: boolean;
  amenities: string[];
  status: RoomStatus;
  availableFrom: string | null;
  minLeaseMonths: number | null;
  maxLeaseMonths: number | null;
  /** Free-text rules. Hidden from public-safe subset. */
  rules: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Public-safe subset — strips owner-only metadata. */
export interface PublicRoomView {
  id: string;
  propertyId: string;
  flatId: string | null;
  label: string;
  roomType: RoomType;
  sizeSqft: string | null;
  maxOccupants: number;
  baseRentMinor: string;
  depositMinor: string;
  currency: string;
  amenities: string[];
  status: RoomStatus;
  availableFrom: string | null;
  minLeaseMonths: number | null;
  maxLeaseMonths: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const roomSelect = {
  id: true,
  propertyId: true,
  flatId: true,
  label: true,
  roomType: true,
  sizeSqft: true,
  maxOccupants: true,
  baseRentMinor: true,
  depositMinor: true,
  currency: true,
  billsIncluded: true,
  amenities: true,
  status: true,
  availableFrom: true,
  minLeaseMonths: true,
  maxLeaseMonths: true,
  rules: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

type RoomRow = {
  id: string;
  propertyId: string;
  flatId: string | null;
  /** Populated only by `getRoom` (ownership checks). */
  flat?: {
    building: { property: { ownerUserId: string; deletedAt: Date | null } };
  } | null;
  label: string;
  roomType: RoomType;
  sizeSqft: unknown;
  maxOccupants: number;
  baseRentMinor: bigint;
  depositMinor: bigint;
  currency: string;
  billsIncluded: boolean;
  amenities: string[];
  status: RoomStatus;
  availableFrom: Date | null;
  minLeaseMonths: number | null;
  maxLeaseMonths: number | null;
  rules: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function decimalToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'object' && v !== null && 'toString' in v) {
    return (v as { toString(): string }).toString();
  }
  return null;
}

function bigintToString(v: bigint): string {
  return v.toString();
}

function dateOnlyToString(v: Date | null): string | null {
  if (!v) return null;
  return v.toISOString().slice(0, 10);
}

function toRoomView(row: RoomRow): RoomView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    flatId: row.flatId,
    label: row.label,
    roomType: row.roomType,
    sizeSqft: decimalToString(row.sizeSqft),
    maxOccupants: row.maxOccupants,
    baseRentMinor: bigintToString(row.baseRentMinor),
    depositMinor: bigintToString(row.depositMinor),
    currency: row.currency,
    billsIncluded: row.billsIncluded,
    amenities: row.amenities,
    status: row.status,
    availableFrom: dateOnlyToString(row.availableFrom),
    minLeaseMonths: row.minLeaseMonths,
    maxLeaseMonths: row.maxLeaseMonths,
    rules: row.rules,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPublicRoomView(row: RoomRow): PublicRoomView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    flatId: row.flatId,
    label: row.label,
    roomType: row.roomType,
    sizeSqft: decimalToString(row.sizeSqft),
    maxOccupants: row.maxOccupants,
    baseRentMinor: bigintToString(row.baseRentMinor),
    depositMinor: bigintToString(row.depositMinor),
    currency: row.currency,
    amenities: row.amenities,
    status: row.status,
    availableFrom: dateOnlyToString(row.availableFrom),
    minLeaseMonths: row.minLeaseMonths,
    maxLeaseMonths: row.maxLeaseMonths,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildPatchData(input: PatchRoomInput): Prisma.RoomUpdateInput {
  const data: Prisma.RoomUpdateInput = {};
  if (input.label !== undefined) data.label = input.label;
  if (input.roomType !== undefined) data.roomType = input.roomType;
  if (input.sizeSqft !== undefined) data.sizeSqft = input.sizeSqft;
  if (input.maxOccupants !== undefined) data.maxOccupants = input.maxOccupants;
  if (input.baseRentMinor !== undefined) data.baseRentMinor = BigInt(input.baseRentMinor);
  if (input.depositMinor !== undefined) data.depositMinor = BigInt(input.depositMinor);
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.billsIncluded !== undefined) data.billsIncluded = input.billsIncluded;
  if (input.amenities !== undefined) data.amenities = input.amenities;
  if (input.availableFrom !== undefined) {
    data.availableFrom = input.availableFrom ? new Date(input.availableFrom) : null;
  }
  if (input.minLeaseMonths !== undefined) data.minLeaseMonths = input.minLeaseMonths;
  if (input.maxLeaseMonths !== undefined) data.maxLeaseMonths = input.maxLeaseMonths;
  if (input.rules !== undefined) data.rules = input.rules;
  return data;
}

// ──────────────────────────────────────────────────────────────────────
// POST /flats/:flat_id/rooms
// ──────────────────────────────────────────────────────────────────────

export async function createRoom(
  flatId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: CreateRoomInput
): Promise<RoomView> {
  // Resolve the flat → building → property chain for ownership and to
  // grab the denormalized `propertyId` for the new room row.
  const flat = await prisma.flat.findFirst({
    where: { id: flatId, deletedAt: null },
    select: {
      building: {
        select: {
          propertyId: true,
          property: { select: { ownerUserId: true, deletedAt: true } },
        },
      },
    },
  });
  if (!flat || flat.building.property.deletedAt !== null) {
    throw new NotFoundError('Flat not found');
  }
  assertCallerOwnsOrAdmin(flat.building.property.ownerUserId, callerUserId, callerRoles);

  const created = await prisma.room.create({
    data: {
      propertyId: flat.building.propertyId,
      flatId,
      label: body.label,
      roomType: body.roomType,
      sizeSqft: body.sizeSqft,
      maxOccupants: body.maxOccupants ?? 1,
      baseRentMinor: BigInt(body.baseRentMinor),
      depositMinor: BigInt(body.depositMinor),
      currency: body.currency,
      billsIncluded: body.billsIncluded ?? false,
      amenities: body.amenities ?? [],
      availableFrom: body.availableFrom ? new Date(body.availableFrom) : null,
      minLeaseMonths: body.minLeaseMonths,
      maxLeaseMonths: body.maxLeaseMonths,
      rules: body.rules,
      status: 'DRAFT',
    },
    select: roomSelect,
  });

  return toRoomView(created);
}

// ──────────────────────────────────────────────────────────────────────
// GET /rooms/:id
// ──────────────────────────────────────────────────────────────────────

export async function getRoom(
  roomId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<RoomView | PublicRoomView> {
  const row = await prisma.room.findFirst({
    where: { id: roomId, deletedAt: null },
    select: {
      ...roomSelect,
      flat: {
        select: {
          building: {
            select: {
              property: { select: { ownerUserId: true, deletedAt: true } },
            },
          },
        },
      },
    },
  });
  if (!row) throw new NotFoundError('Room not found');

  // Public-safe subset if (a) caller is anonymous-style (no admin role
  // and doesn't own the property), or (b) the parent property is
  // soft-deleted (only admins should see those).
  const isAdmin = callerRoles.includes('ADMIN');
  const ownerUserId = row.flat?.building.property.ownerUserId ?? null;
  const isOwner = ownerUserId !== null && ownerUserId === callerUserId;

  if (isAdmin || isOwner) {
    return toRoomView(row as RoomRow);
  }
  return toPublicRoomView(row as RoomRow);
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /rooms/:id
// ──────────────────────────────────────────────────────────────────────

export async function patchRoom(
  roomId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: PatchRoomInput
): Promise<RoomView> {
  // Ownership check via the helper (also throws NotFound if missing).
  const ownerId = await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const before = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, status: true, version: true, label: true },
  });
  if (!before) throw new NotFoundError('Room not found');

  const updated = await prisma.room.update({
    where: { id: roomId },
    data: buildPatchData(body),
    select: roomSelect,
  });

  await prisma.auditLog.create({
    data: {
      actorUserId: callerUserId,
      actorRole: callerRoles.find((r) => r === 'OWNER' || r === 'ADMIN') ?? null,
      action: 'room.updated',
      targetEntityType: 'room',
      targetEntityId: updated.id,
      before: { status: before.status, version: before.version, label: before.label },
      after: { status: updated.status, version: updated.version, label: updated.label },
    },
  });

  return toRoomView(updated as RoomRow);
}

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/publish — DRAFT → PUBLISHED
// ──────────────────────────────────────────────────────────────────────

export async function publishRoom(
  roomId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<RoomView> {
  // KYC gate (02 §2.6): publishing requires KYC_APPROVED.
  await assertKycApprovedForOwner(callerUserId);

  const ownerId = await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const before = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, status: true, version: true },
  });
  if (!before) throw new NotFoundError('Room not found');
  if (before.status !== 'DRAFT') {
    throw new ConflictError(
      'STATE_MACHINE',
      `Room is in ${before.status}; only DRAFT can be published`
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    // Optimistic-lock guarded update.
    const updateResult = await tx.room.updateMany({
      where: { id: roomId, version: before.version, status: 'DRAFT', deletedAt: null },
      data: { status: 'PUBLISHED', version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw new ConflictError('STATE_MACHINE', 'Room version conflict; reload and retry');
    }

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'room.published',
        targetEntityType: 'room',
        targetEntityId: roomId,
        before: { status: 'DRAFT', version: before.version },
        after: { status: 'PUBLISHED', version: before.version + 1 },
      },
    });

    

    return tx.room.findUniqueOrThrow({
      where: { id: roomId },
      select: roomSelect,
    });
  });

  return toRoomView(result as RoomRow);
}

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/transition — generic state transition
// ──────────────────────────────────────────────────────────────────────

export async function transitionRoom(
  roomId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: TransitionRoomInput
): Promise<RoomView> {
  const ownerId = await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const before = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, status: true, version: true },
  });
  if (!before) throw new NotFoundError('Room not found');

  // State-machine guard.
  if (!isValidTransition(before.status, body.to)) {
    throw new ConflictError('STATE_MACHINE', `Invalid transition: ${before.status} → ${body.to}`);
  }

  // Caller-role guard per the trigger matrix in rooms.state-machine.ts.
  // ADMIN is allowed for any transition including TAKEN_DOWN.
  // OWNER is allowed for: DRAFT→PUBLISHED, PUBLISHED→MAINTENANCE,
  // MAINTENANCE→PUBLISHED, MAINTENANCE_CHECK→PUBLISHED.
  const isAdmin = callerRoles.includes('ADMIN');
  if (!isAdmin) {
    const ownerAllowed: Array<[RoomStatus, RoomStatus]> = [
      ['DRAFT', 'PUBLISHED'],
      ['PUBLISHED', 'MAINTENANCE'],
      ['MAINTENANCE', 'PUBLISHED'],
      ['MAINTENANCE_CHECK', 'PUBLISHED'],
    ];
    const ok = ownerAllowed.some(([from, to]) => from === before.status && to === body.to);
    if (!ok) {
      throw new ForbiddenError(
        'FORBIDDEN',
        `OWNER cannot transition room from ${before.status} to ${body.to}`
      );
    }
  }

  // Optimistic-concurrency guard.
  const expectedVersion = body.expectedVersion ?? before.version;

  const result = await prisma.$transaction(async (tx) => {
    const updateResult = await tx.room.updateMany({
      where: {
        id: roomId,
        version: expectedVersion,
        status: before.status,
        deletedAt: null,
      },
      data: { status: body.to, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw new ConflictError('STATE_MACHINE', 'Room version conflict; reload and retry');
    }

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: callerRoles.find((r) => r === 'OWNER' || r === 'ADMIN') ?? null,
        action: 'room.transition',
        targetEntityType: 'room',
        targetEntityId: roomId,
        before: { status: before.status, version: before.version },
        after: { status: body.to, version: before.version + 1 },
      },
    });

    // SPEC: §3.1 only requires audit event for property.published;
    // explicit room transitions are not enumerated as audit events
    // until notification fan-out lands (Phase 18).

    return tx.room.findUniqueOrThrow({
      where: { id: roomId },
      select: roomSelect,
    });
  });

  return toRoomView(result as RoomRow);
}

// ──────────────────────────────────────────────────────────────────────
// Room photos — Cloudinary-backed gallery
// ──────────────────────────────────────────────────────────────────────
//
// Delivery type is `upload` (public CDN), not `authenticated`: these are
// listing images on a PUBLISHED room, meant to be fetched by anonymous
// browsers. Private assets (KYC scans, leases) live in the documents
// module and are signed per request.
//
// `position` is normalised to a dense 0..n-1 sequence on every mutation so
// clients can render `ORDER BY position` without reasoning about gaps.

export interface RoomPhotoView {
  id: string;
  roomId: string;
  url: string;
  contentType: string;
  sizeBytes: string;
  width: number | null;
  height: number | null;
  position: number;
  alt: string | null;
  createdAt: string;
}

type RoomPhotoRow = {
  id: string;
  roomId: string;
  secureUrl: string;
  contentType: string;
  sizeBytes: bigint;
  width: number | null;
  height: number | null;
  position: number;
  alt: string | null;
  createdAt: Date;
};

function photoRowToView(r: RoomPhotoRow): RoomPhotoView {
  return {
    id: r.id,
    roomId: r.roomId,
    url: r.secureUrl,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes.toString(),
    width: r.width,
    height: r.height,
    position: r.position,
    alt: r.alt,
    createdAt: r.createdAt.toISOString(),
  };
}

const photoSelect = {
  id: true,
  roomId: true,
  secureUrl: true,
  contentType: true,
  sizeBytes: true,
  width: true,
  height: true,
  position: true,
  alt: true,
  createdAt: true,
} as const;

/** Hard ceiling per listing — keeps one owner from filling the account. */
export const MAX_PHOTOS_PER_ROOM = 20;

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/photos
// ──────────────────────────────────────────────────────────────────────

export interface UploadRoomPhotoServiceInput {
  fields: UploadPhotoInput;
  file: { buffer: Buffer; mimetype: string; size: number };
}

/**
 * Uploads one image to Cloudinary and appends it to the room gallery.
 *
 * The per-room cap is checked before the upload so a rejected request
 * never spends storage. There is a benign race there — two concurrent
 * uploads at the cap boundary can both pass — which we accept: the cost
 * is one extra photo, and the alternative (locking the room row for the
 * duration of a network upload) would serialise a multi-second operation.
 */
export async function uploadRoomPhoto(
  roomId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  input: UploadRoomPhotoServiceInput
): Promise<RoomPhotoView> {
  const ownerId = await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const live = await prisma.roomPhoto.count({ where: { roomId, deletedAt: null } });
  if (live >= MAX_PHOTOS_PER_ROOM) {
    // ConflictError's top-level code is a closed union; the specific
    // reason rides in the field-level error so clients can still branch.
    throw new ConflictError('CONFLICT', `A room may have at most ${MAX_PHOTOS_PER_ROOM} photos`, [
      {
        field: 'file',
        code: 'PHOTO_LIMIT_REACHED',
        message: `delete a photo before adding another (max ${MAX_PHOTOS_PER_ROOM})`,
      },
    ]);
  }

  const asset = await uploadBuffer(input.file.buffer, {
    folder: `rooms/${roomId}`,
    deliveryType: 'upload',
    resourceType: 'image',
    publicId: randomUUID(),
  });

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Append by default; an explicit `position` inserts at that slot and
      // pushes the rest down. Recomputed inside the transaction so two
      // concurrent uploads cannot both claim the same tail index.
      const count = await tx.roomPhoto.count({ where: { roomId, deletedAt: null } });
      const requested = input.fields.position;
      const position = requested === undefined ? count : Math.min(requested, count);

      if (position < count) {
        await tx.roomPhoto.updateMany({
          where: { roomId, deletedAt: null, position: { gte: position } },
          data: { position: { increment: 1 } },
        });
      }

      return await tx.roomPhoto.create({
        data: {
          roomId,
          uploadedByUserId: callerUserId,
          publicId: asset.publicId,
          secureUrl: asset.secureUrl,
          storageProvider: 'cloudinary',
          resourceType: asset.resourceType,
          deliveryType: asset.deliveryType,
          contentType: input.file.mimetype,
          // Cloudinary's count is authoritative — it may re-encode.
          sizeBytes: BigInt(asset.bytes),
          width: asset.width,
          height: asset.height,
          etag: asset.etag,
          position,
          alt: input.fields.alt ?? null,
        },
        select: photoSelect,
      });
    });

    return photoRowToView(created as RoomPhotoRow);
  } catch (err) {
    // The bytes are in Cloudinary but no row references them. Compensate
    // so a failed INSERT does not leak a paid-for asset.
    await destroyAsset({
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      deliveryType: asset.deliveryType,
    }).catch((cleanupErr) => {
      logger.error({ err: cleanupErr, publicId: asset.publicId }, 'photo_orphan_cleanup_failed');
    });
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /rooms/:id/photos
// ──────────────────────────────────────────────────────────────────────

export async function listRoomPhotos(roomId: string): Promise<RoomPhotoView[]> {
  await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  const rows = await prisma.roomPhoto.findMany({
    where: { roomId, deletedAt: null },
    orderBy: { position: 'asc' },
    select: photoSelect,
  });
  return rows.map((r) => photoRowToView(r as RoomPhotoRow));
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /rooms/:id/photos/:photo_id
// ──────────────────────────────────────────────────────────────────────

/**
 * Soft-deletes the row, closes the gap it left in the ordering, then
 * destroys the remote asset.
 *
 * The destroy runs after the transaction commits for the same reason as
 * documents: an orphaned asset costs storage, whereas destroying first
 * and then rolling back would leave a live row pointing at nothing.
 */
export async function deleteRoomPhoto(
  roomId: string,
  photoId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<{ id: string; deleted: true }> {
  const ownerId = await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const toDestroy = await prisma.$transaction(async (tx) => {
    const row = await tx.roomPhoto.findFirst({
      where: { id: photoId, roomId, deletedAt: null },
      select: {
        id: true,
        position: true,
        publicId: true,
        resourceType: true,
        deliveryType: true,
        storageProvider: true,
      },
    });
    if (!row) throw new NotFoundError('Photo not found');

    await tx.roomPhoto.update({
      where: { id: photoId },
      data: { deletedAt: new Date() },
    });

    // Close the hole so positions stay dense.
    await tx.roomPhoto.updateMany({
      where: { roomId, deletedAt: null, position: { gt: row.position } },
      data: { position: { decrement: 1 } },
    });

    return row.storageProvider === 'cloudinary'
      ? {
          publicId: row.publicId,
          resourceType: row.resourceType,
          deliveryType: row.deliveryType,
        }
      : null;
  });

  if (toDestroy) {
    await destroyAsset(toDestroy).catch((err) => {
      logger.error({ err, publicId: toDestroy.publicId }, 'photo_asset_destroy_failed');
    });
  }

  return { id: photoId, deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/photos/:photo_id/reorder
// ──────────────────────────────────────────────────────────────────────

/**
 * Moves one photo to `position`, shifting the rest to keep 0..n-1 dense.
 *
 * The whole reshuffle runs in one transaction, and the moving row is
 * parked at -1 first so no intermediate state has two rows sharing a
 * position — which is also why `(room_id, position)` is a plain index and
 * not a UNIQUE constraint.
 */
export async function reorderRoomPhoto(
  roomId: string,
  photoId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  target: number
): Promise<RoomPhotoView[]> {
  const ownerId = await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  return await prisma.$transaction(async (tx) => {
    const row = await tx.roomPhoto.findFirst({
      where: { id: photoId, roomId, deletedAt: null },
      select: { id: true, position: true },
    });
    if (!row) throw new NotFoundError('Photo not found');

    const count = await tx.roomPhoto.count({ where: { roomId, deletedAt: null } });
    // Clamp rather than reject: "move to the end" is a normal request and
    // the client should not have to know the current photo count.
    const to = Math.min(Math.max(target, 0), count - 1);
    const from = row.position;

    if (to !== from) {
      await tx.roomPhoto.update({ where: { id: photoId }, data: { position: -1 } });

      if (to < from) {
        // Moving up: everything in [to, from-1] slides down one slot.
        await tx.roomPhoto.updateMany({
          where: { roomId, deletedAt: null, position: { gte: to, lt: from } },
          data: { position: { increment: 1 } },
        });
      } else {
        // Moving down: everything in (from, to] slides up one slot.
        await tx.roomPhoto.updateMany({
          where: { roomId, deletedAt: null, position: { gt: from, lte: to } },
          data: { position: { decrement: 1 } },
        });
      }

      await tx.roomPhoto.update({ where: { id: photoId }, data: { position: to } });
    }

    const rows = await tx.roomPhoto.findMany({
      where: { roomId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: photoSelect,
    });
    return rows.map((r) => photoRowToView(r as RoomPhotoRow));
  });
}

// For ownership checks outside this file, use `resolveOwnerIdForRoom`
// from `properties.service.ts`.
