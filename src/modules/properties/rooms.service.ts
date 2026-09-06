// src/modules/properties/rooms.service.ts
//
// Business logic for /rooms/* per spec §13.2.3 + 05 §5.4 (room state
// machine) + 05 §6 (optimistic concurrency via `version`).
//
// Surfaces:
//   GET   /rooms/:id                  public-safe if not owner/admin
//   PATCH /rooms/:id                  OWNER (own via property)
//   POST  /rooms/:id/publish          OWNER (own) + KYC_APPROVED — DRAFT→PUBLISHED
//   POST  /rooms/:id/transition       OWNER (own) / ADMIN — explicit transition
//   POST  /rooms/:id/photos           OWNER (own) — presigned-URL stub
//   DELETE /rooms/:id/photos/:photo_id OWNER (own) — 501 stub (Phase 18)
//   POST  /rooms/:id/photos/:photo_id/reorder OWNER (own) — 501 stub
//
// Atomicity: every state transition (publish + transition) runs the
// row update inside a `prisma.$transaction` along with audit_log and
// (for publish) outbox_events. Optimistic concurrency: UPDATE WHERE
// id=? AND version=? — 0 rows affected → 409 STATE_MACHINE.

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { RoomStatus, RoomType } from '@/generated/prisma/enums';

import { prisma } from '@/lib/db';
import { ApiError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';

import {
  assertCallerOwnsOrAdmin,
  assertKycApprovedForOwner,
  resolveOwnerIdForRoom,
} from './properties.service';
import type {
  CreateRoomInput,
  PatchRoomInput,
  RequestPhotoUploadInput,
  TransitionRoomInput,
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
  /** Populated only by `loadOwnedRoom` and `getRoom` (ownership checks). */
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

/**
 * Load a room + resolve its property-owner for ABAC checks. Throws
 * NotFoundError if the room (or its parent chain) is missing/soft-
 * deleted.
 */
async function loadOwnedRoom(
  roomId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<RoomRow> {
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
  const isAdmin = callerRoles.includes('ADMIN');
  if (!isAdmin) {
    // For non-admin callers, the room must belong to one of their
    // (non-deleted) properties.
    const ownerUserId = row.flat?.building.property.ownerUserId ?? null;
    if (ownerUserId === null || row.flat?.building.property.deletedAt !== null) {
      throw new NotFoundError('Room not found');
    }
    if (ownerUserId !== callerUserId) {
      throw new ForbiddenError('NOT_OWNER', 'Caller does not own this room');
    }
  } else {
    // ADMIN: ensure parent chain isn't soft-deleted.
    if (row.flat?.building.property.deletedAt !== null) {
      throw new NotFoundError('Room not found');
    }
  }
  return row as RoomRow;
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

    await tx.outboxEvent.create({
      data: {
        eventType: 'room.published',
        payload: {
          roomId,
          propertyId: (await tx.room.findUnique({
            where: { id: roomId },
            select: { propertyId: true },
          }))!.propertyId,
          ownerUserId: callerUserId,
        } as Prisma.InputJsonValue,
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

    // SPEC: §3.1 only requires outbox event for property.published;
    // explicit room transitions are not enumerated as outbox events
    // until notification fan-out lands (Phase 18).

    return tx.room.findUniqueOrThrow({
      where: { id: roomId },
      select: roomSelect,
    });
  });

  return toRoomView(result as RoomRow);
}

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/photos — presigned URL stub (Phase 18 owns the real impl)
// ──────────────────────────────────────────────────────────────────────

export interface PhotoUploadStub {
  url: string;
  objectKey: string;
  expiresAt: string;
}

export async function requestPhotoUpload(
  roomId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: RequestPhotoUploadInput
): Promise<PhotoUploadStub> {
  const ownerId = await resolveOwnerIdForRoom(roomId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const ext = body.ext ?? (body.contentType.split('/')[1] ?? 'jpg').toLowerCase();
  const objectKey = `rooms/${roomId}/${randomUUID()}.${ext}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
  const url = `https://stub.local/${objectKey}?expires=${expiresAt.getTime()}`;

  // No DB row written — Phase 18 owns the room_photos table.
  return {
    url,
    objectKey,
    expiresAt: expiresAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /rooms/:id/photos/:photo_id — 501 stub
// ──────────────────────────────────────────────────────────────────────

export function deletePhotoStub(): never {
  throw new ApiError(
    501,
    'NOT_IMPLEMENTED',
    'Photo upload/delete/reorder ships with Phase 18 (real S3 wiring)'
  );
}

export function reorderPhotoStub(): never {
  throw new ApiError(
    501,
    'NOT_IMPLEMENTED',
    'Photo upload/delete/reorder ships with Phase 18 (real S3 wiring)'
  );
}

// `loadOwnedRoom` is intentionally not exported — it's a private helper
// for internal callers within this file. Use `resolveOwnerIdForRoom`
// from `properties.service.ts` for ownership checks elsewhere.
