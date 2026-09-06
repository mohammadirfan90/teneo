// src/modules/properties/flats.service.ts
//
// Business logic for /flats/* per spec §13.2.3.
//
// Surfaces:
//   POST /buildings/:building_id/flats   OWNER (own via building→property)

import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

import type { CreateFlatInput } from './flats.schemas';
import { assertCallerOwnsOrAdmin, resolveOwnerIdForBuilding } from './properties.service';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface FlatView {
  id: string;
  buildingId: string;
  floor: number | null;
  doorNumber: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const flatSelect = {
  id: true,
  buildingId: true,
  floor: true,
  doorNumber: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

type FlatRow = {
  id: string;
  buildingId: string;
  floor: number | null;
  doorNumber: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
};

function toFlatView(row: FlatRow): FlatView {
  return {
    id: row.id,
    buildingId: row.buildingId,
    floor: row.floor,
    doorNumber: row.doorNumber,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /buildings/:building_id/flats
// ──────────────────────────────────────────────────────────────────────

export async function createFlat(
  buildingId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: CreateFlatInput
): Promise<FlatView> {
  const ownerId = await resolveOwnerIdForBuilding(buildingId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const created = await prisma.flat.create({
    data: {
      buildingId,
      floor: body.floor,
      doorNumber: body.doorNumber,
      status: 'ACTIVE',
    },
    select: flatSelect,
  });
  return toFlatView(created);
}
