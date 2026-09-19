// src/modules/properties/properties.service.ts
//
// Business logic for /properties/* per spec §13.2.3 + 04 §4.3.2 + 02 §2.6.
//
// Surfaces (from 13 §13.2.3):
// POST /properties OWNER + KYC_APPROVED (for OWNER role) — create DRAFT
// GET /properties/:id any logged-in (public-safe subset if not owner/admin)
// PATCH /properties/:id OWNER (own) or ADMIN
// DELETE /properties/:id OWNER (own) or ADMIN — soft-delete
// POST /properties/:id/publish OWNER (own) + KYC_APPROVED — cascade rooms
// GET /properties/me OWNER — cursor-paginated own list
//
// Atomicity: the publish cascade runs in a single $transaction that
// 1. flips property status DRAFT → PUBLISHED, sets published_at,
// bumps version (optimistic concurrency, 05 §6)
// 2. flips every DRAFT room on this property → PUBLISHED (also bumps
// their version)
// 3. writes audit_log row (action=property.published)
// 4. writes audit events row (eventType=property.published) for
// the search indexer + notification fan-out (per 03 §3.1)

import type { Prisma } from '@/generated/prisma/client';
import type { PropertyStatus, PropertyType, RoomStatus } from '@/generated/prisma/enums';

import * as cacheLib from '@/lib/cache';
import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import type {
  CreatePropertyInput,
  ListMyPropertiesQuery,
  PatchPropertyInput,
} from './properties.schemas';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface PropertyView {
  id: string;
  ownerUserId: string;
  title: string;
  description: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  area: string | null;
  postalCode: string | null;
  countryCode: string;
  latitude: string | null;
  longitude: string | null;
  propertyType: PropertyType;
  status: PropertyStatus;
  publishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyListPage {
  items: PropertyView[];
  nextCursor: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const propertySelect = {
  id: true,
  ownerUserId: true,
  title: true,
  description: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  area: true,
  postalCode: true,
  countryCode: true,
  latitude: true,
  longitude: true,
  propertyType: true,
  status: true,
  publishedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PropertyRow = {
  id: string;
  ownerUserId: string;
  title: string;
  description: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  area: string | null;
  postalCode: string | null;
  countryCode: string;
  latitude: unknown;
  longitude: unknown;
  propertyType: PropertyType;
  status: PropertyStatus;
  publishedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function toPropertyView(row: PropertyRow): PropertyView {
  // Prisma returns Decimal for latitude/longitude; serialise to string
  // for stable JSON across runtimes (and to avoid float drift).
  const toStr = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return v.toString();
    if (typeof v === 'object' && v !== null && 'toString' in v) {
      return (v as { toString(): string }).toString();
    }
    return null;
  };
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    title: row.title,
    description: row.description,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    area: row.area,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    latitude: toStr(row.latitude),
    longitude: toStr(row.longitude),
    propertyType: row.propertyType,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Build the Prisma patch payload from the schema input. */
function buildPatchData(input: PatchPropertyInput): Prisma.PropertyUpdateInput {
  const data: Prisma.PropertyUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.addressLine1 !== undefined) data.addressLine1 = input.addressLine1;
  if (input.addressLine2 !== undefined) data.addressLine2 = input.addressLine2;
  if (input.city !== undefined) data.city = input.city;
  if (input.area !== undefined) data.area = input.area;
  if (input.postalCode !== undefined) data.postalCode = input.postalCode;
  if (input.countryCode !== undefined) data.countryCode = input.countryCode;
  if (input.latitude !== undefined) data.latitude = input.latitude;
  if (input.longitude !== undefined) data.longitude = input.longitude;
  if (input.propertyType !== undefined) data.propertyType = input.propertyType;
  return data;
}

/**
 * Authorization helper — caller must own the property OR be ADMIN.
 * Throws NotOwnerError if neither.
 */
async function loadOwnedProperty(
  propertyId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<PropertyRow> {
  const row = await prisma.property.findFirst({
    where: { id: propertyId, deletedAt: null },
    select: propertySelect,
  });
  if (!row) throw new NotFoundError('Property not found');
  const isAdmin = callerRoles.includes('ADMIN');
  if (!isAdmin && row.ownerUserId !== callerUserId) {
    // Don't leak existence to non-owners.
    throw new NotFoundError('Property not found');
  }
  return row;
}

/**
 * KYC gate — caller must hold the OWNER role and have
 * `owner_profiles.kyc_status = APPROVED` (02 §2.6). Throws
 * ForbiddenError(KYC_REQUIRED) otherwise.
 */
export async function assertKycApprovedForOwner(userId: string): Promise<void> {
  const profile = await prisma.ownerProfile.findUnique({
    where: { userId },
    select: { kycStatus: true },
  });
  if (!profile) {
    throw new ForbiddenError(
      'KYC_REQUIRED',
      'Owner profile not set up; PATCH /profiles/owner first'
    );
  }
  if (profile.kycStatus !== 'APPROVED') {
    throw new ForbiddenError('KYC_REQUIRED', 'OWNER role requires KYC approval before publishing');
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /properties
// ──────────────────────────────────────────────────────────────────────

export async function createProperty(
  userId: string,
  body: CreatePropertyInput
): Promise<PropertyView> {
  // KYC gate (02 §2.6): only KYC_APPROVED OWNERs can create a property
  // ready for publication. DRAFTs can be created without KYC? The spec
  // is silent on the create path, but a strict reading says publishing
  // is what's gated. We follow the strict path: require KYC_APPROVED
  // before allowing ANY property creation, mirroring the publish gate.
  await assertKycApprovedForOwner(userId);

  const created = await prisma.property.create({
    data: {
      ownerUserId: userId,
      title: body.title,
      description: body.description,
      addressLine1: body.addressLine1,
      addressLine2: body.addressLine2,
      city: body.city,
      area: body.area,
      postalCode: body.postalCode,
      countryCode: body.countryCode,
      latitude: body.latitude,
      longitude: body.longitude,
      propertyType: body.propertyType,
      status: 'DRAFT',
    },
    select: propertySelect,
  });
  return toPropertyView(created);
}

// ──────────────────────────────────────────────────────────────────────
// GET /properties/:id
// ──────────────────────────────────────────────────────────────────────

export async function getProperty(
  propertyId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<PropertyView> {
  void callerUserId;
  void callerRoles;

  // Phase 21: cache lookup. Misses fall through to the DB; we also
  // negative-cache 404s for 60s per SPEC §8.4.1 (deflect enumeration
  // of /properties/:id by unauthorized clients).
  const key = `property:${propertyId}`;
  const cached = await cacheLib.get<PropertyView>(key);
  if (cached !== null) {
    if (cacheLib.isNegative(cached)) {
      logger.info({ key }, 'cache_negative_hit');
      throw new NotFoundError('Property not found');
    }
    logger.info({ key }, 'cache_hit');
    return cached;
  }

  const row = await prisma.property.findFirst({
    where: { id: propertyId, deletedAt: null },
    select: propertySelect,
  });
  if (!row) {
    // Negative-cache 404s for 60s. Tagged with property:{id} so a
    // property becoming findable (e.g., via admin reinstate) evicts
    // the negative too.
    await cacheLib.cacheNegative(key, 60);
    throw new NotFoundError('Property not found');
  }
  const view = toPropertyView(row);
  await cacheLib.taggedSet(key, view, 600, [`property:${propertyId}`]);
  return view;
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /properties/:id
// ──────────────────────────────────────────────────────────────────────

export async function patchProperty(
  propertyId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: PatchPropertyInput
): Promise<PropertyView> {
  // First confirm ownership (and that the row isn't soft-deleted).
  await loadOwnedProperty(propertyId, callerUserId, callerRoles);

  const before = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, ownerUserId: true, title: true, status: true, version: true },
  });
  if (!before) throw new NotFoundError('Property not found');

  const updated = await prisma.property.update({
    where: { id: propertyId },
    data: buildPatchData(body),
    select: propertySelect,
  });

  // Audit the change (no audit event for non-publish edits per spec;
  // 03 §3.1 only enumerates property.published).
  await prisma.auditLog.create({
    data: {
      actorUserId: callerUserId,
      actorRole: callerRoles.find((r) => r === 'OWNER' || r === 'ADMIN') ?? null,
      action: 'property.updated',
      targetEntityType: 'property',
      targetEntityId: updated.id,
      before: { title: before.title, status: before.status, version: before.version },
      after: { title: updated.title, status: updated.status, version: updated.version },
    },
  });

  // Phase 21: bust the per-property cache, the search cache for
  // this city (PATCH may change the title used in search snippets),
  // and the owner's dashboard list (which embeds the same row).
  await Promise.all([
    cacheLib.invalidateTag(`property:${updated.id}`),
    cacheLib.invalidateTag(`search:${updated.city.toLowerCase()}`),
    cacheLib.invalidateTag(`properties:owner:${updated.ownerUserId}`),
  ]);

  return toPropertyView(updated);
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /properties/:id (soft-delete)
// ──────────────────────────────────────────────────────────────────────

export async function softDeleteProperty(
  propertyId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<{ id: string; deletedAt: string }> {
  const existing = await loadOwnedProperty(propertyId, callerUserId, callerRoles);

  const now = new Date();
  const updated = await prisma.property.update({
    where: { id: propertyId },
    data: { deletedAt: now, status: 'TAKEN_DOWN' },
    select: { id: true, deletedAt: true, status: true, version: true },
  });

  // audit — soft-delete is a published-side event too.
  await prisma.auditLog.create({
    data: {
      actorUserId: callerUserId,
      actorRole: callerRoles.find((r) => r === 'OWNER' || r === 'ADMIN') ?? null,
      action: 'property.soft_deleted',
      targetEntityType: 'property',
      targetEntityId: updated.id,
      before: { status: existing.status, version: existing.version, deletedAt: null },
      after: { status: updated.status, version: updated.version, deletedAt: now.toISOString() },
    },
  });

  

  // Phase 21: evict cache entries for this property, the city's search
  // results, and the owner's dashboard list (soft-delete hides it
  // from search and from /me).
  await Promise.all([
    cacheLib.invalidateTag(`property:${updated.id}`),
    cacheLib.invalidateTag(`search:${existing.city.toLowerCase()}`),
    cacheLib.invalidateTag(`properties:owner:${callerUserId}`),
  ]);

  return {
    id: updated.id,
    deletedAt: updated.deletedAt?.toISOString() ?? now.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /properties/:id/publish — cascade to rooms
// ──────────────────────────────────────────────────────────────────────

export async function publishProperty(
  propertyId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): Promise<{ id: string; status: PropertyStatus; publishedAt: string; roomsPublished: number }> {
  // KYC gate (02 §2.6): publishing requires KYC_APPROVED.
  await assertKycApprovedForOwner(callerUserId);

  // Ownership check + existence.
  const existing = await loadOwnedProperty(propertyId, callerUserId, callerRoles);
  if (existing.status === 'PUBLISHED') {
    throw new ConflictError(
      'STATE_MACHINE',
      'Property is already PUBLISHED; only DRAFT can be published'
    );
  }
  if (existing.status === 'TAKEN_DOWN') {
    throw new ConflictError(
      'STATE_MACHINE',
      'Property is TAKEN_DOWN; cannot be re-published (create a new property)'
    );
  }

  // Count DRAFT rooms — we want zero or more, never require at least
  // one (publishing an empty property is legal; the owner simply has
  // no rooms yet).
  const draftRoomIds = await prisma.room.findMany({
    where: { propertyId, status: 'DRAFT', deletedAt: null },
    select: { id: true },
  });

  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // 1. Property flip with optimistic-version guard.
    const updateResult = await tx.property.updateMany({
      where: { id: propertyId, version: existing.version, deletedAt: null },
      data: { status: 'PUBLISHED', publishedAt: now, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw new ConflictError('STATE_MACHINE', 'Property version conflict; reload and retry');
    }

    // 2. Cascade every DRAFT room → PUBLISHED.
    let roomsPublished = 0;
    if (draftRoomIds.length > 0) {
      const roomUpdate = await tx.room.updateMany({
        where: { id: { in: draftRoomIds.map((r) => r.id) }, status: 'DRAFT' },
        data: { status: 'PUBLISHED', version: { increment: 1 } },
      });
      roomsPublished = roomUpdate.count;
    }

    // 3. Audit row.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'property.published',
        targetEntityType: 'property',
        targetEntityId: propertyId,
        before: { status: existing.status, version: existing.version },
        after: {
          status: 'PUBLISHED',
          version: existing.version + 1,
          publishedAt: now.toISOString(),
          roomsPublished,
        },
      },
    });

    // 4. audit event (search indexer + notification fan-out).
    

    return { roomsPublished };
  });

  return {
    id: propertyId,
    status: 'PUBLISHED' as PropertyStatus,
    publishedAt: now.toISOString(),
    roomsPublished: result.roomsPublished,
  };
}

// ──────────────────────────────────────────────────────────────────────
// GET /properties/me — cursor-paginated own list
// ──────────────────────────────────────────────────────────────────────

export async function listMyProperties(
  ownerUserId: string,
  query: ListMyPropertiesQuery
): Promise<PropertyListPage> {
  // Phase 21: cache the per-owner list. TTL 60s — owners see their
  // own changes within a minute, which is the SPEC ceiling for
  // staleness in a marketplace dashboard.
  const cacheKey = `properties:owner:${ownerUserId}:${query.cursor ?? ''}:${query.limit}`;
  const cached = await cacheLib.get<PropertyListPage>(cacheKey);
  if (cached !== null) {
    logger.info({ cacheKey }, 'cache_hit');
    return cached;
  }

  // query.limit is schema-coerced to a finite number by listMyPropertiesQuerySchema
  // (z.coerce.number().int().min(1).max(100).default(20)).
  const limit = query.limit;
  const take = limit + 1; // +1 so we can detect "more pages"
  const rows = await prisma.property.findMany({
    where: { ownerUserId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    select: propertySelect,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  const result: PropertyListPage = {
    items: page.map(toPropertyView),
    nextCursor,
  };
  await cacheLib.taggedSet(cacheKey, result, 60, [`properties:owner:${ownerUserId}`]);
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers exported for sibling modules (buildings / flats / rooms)
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the owning userId for a child resource (building, flat, room)
 * by walking the parent chain. Returns null if any link is missing or
 * the chain leads to a soft-deleted property. Throws NotFoundError if
 * the immediate parent doesn't exist.
 */
export async function resolveOwnerIdForRoom(roomId: string): Promise<string | null>;
export async function resolveOwnerIdForRoom(
  roomId: string,
  opts: { throwIfMissing: true }
): Promise<string>;
export async function resolveOwnerIdForRoom(
  roomId: string,
  opts?: { throwIfMissing?: boolean }
): Promise<string | null> {
  const room = await prisma.room.findFirst({
    where: { id: roomId, deletedAt: null },
    select: { property: { select: { ownerUserId: true, deletedAt: true } } },
  });
  if (!room) {
    if (opts?.throwIfMissing) throw new NotFoundError('Room not found');
    return null;
  }
  if (room.property.deletedAt !== null) {
    if (opts?.throwIfMissing) throw new NotFoundError('Room not found');
    return null;
  }
  return room.property.ownerUserId;
}

export async function resolveOwnerIdForBuilding(
  buildingId: string,
  opts: { throwIfMissing: true }
): Promise<string>;
export async function resolveOwnerIdForBuilding(
  buildingId: string,
  opts?: { throwIfMissing?: boolean }
): Promise<string | null> {
  const building = await prisma.building.findFirst({
    where: { id: buildingId, deletedAt: null },
    select: { property: { select: { ownerUserId: true, deletedAt: true } } },
  });
  if (!building || building.property.deletedAt !== null) {
    if (opts?.throwIfMissing) throw new NotFoundError('Building not found');
    return null;
  }
  return building.property.ownerUserId;
}

export async function resolveOwnerIdForFlat(
  flatId: string,
  opts: { throwIfMissing: true }
): Promise<string>;
export async function resolveOwnerIdForFlat(
  flatId: string,
  opts?: { throwIfMissing?: boolean }
): Promise<string | null> {
  const flat = await prisma.flat.findFirst({
    where: { id: flatId, deletedAt: null },
    select: {
      building: {
        select: { property: { select: { ownerUserId: true, deletedAt: true } } },
      },
    },
  });
  if (!flat || flat.building.property.deletedAt !== null) {
    if (opts?.throwIfMissing) throw new NotFoundError('Flat not found');
    return null;
  }
  return flat.building.property.ownerUserId;
}

/** Standard ownership-or-admin gate for child resources. */
export function assertCallerOwnsOrAdmin(
  ownerUserId: string,
  callerUserId: string,
  callerRoles: readonly string[]
): void {
  const isAdmin = callerRoles.includes('ADMIN');
  if (!isAdmin && ownerUserId !== callerUserId) {
    throw new ForbiddenError('NOT_OWNER', 'Caller does not own this resource');
  }
}

/** Re-export types so other modules can compose them. */
export type { RoomStatus };
