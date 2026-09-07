// src/modules/admin/feature-flags.service.ts
//
// Phase 19: feature-flag CRUD + a thin read helper for hot paths.
//
//   listFlags()                — for GET /admin/feature-flags
//   upsertFlag(...)            — for PUT /admin/feature-flags/:key
//   isFeatureEnabled(key)      — exported for Phase 20+ consumers
//                                (e.g., Stripe kill switch in
//                                payments.service.ts). Phase 19
//                                does not wire any consumer — the
//                                helper ships in case a future
//                                caller imports it.
//
// Every upsert writes an audit_log row so the operator can later
// review who toggled what flag and when.

import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

import { writeAuditLog } from './admin.service';

// ──────────────────────────────────────────────────────────────────────
// View type
// ──────────────────────────────────────────────────────────────────────

export interface FeatureFlagView {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedAt: string;
  createdAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Row mapper
// ──────────────────────────────────────────────────────────────────────

type FeatureFlagRow = {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedAt: Date;
  createdAt: Date;
};

function rowToView(r: FeatureFlagRow): FeatureFlagView {
  return {
    key: r.key,
    enabled: r.enabled,
    description: r.description,
    updatedAt: r.updatedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// listFlags — GET /admin/feature-flags
// ──────────────────────────────────────────────────────────────────────

export async function listFlags(): Promise<FeatureFlagView[]> {
  const rows = await prisma.featureFlag.findMany({
    orderBy: { key: 'asc' },
  });
  return rows.map((r) => rowToView(r as FeatureFlagRow));
}

// ──────────────────────────────────────────────────────────────────────
// upsertFlag — PUT /admin/feature-flags/:key
// ──────────────────────────────────────────────────────────────────────

export interface UpsertFlagInput {
  key: string;
  enabled: boolean;
  description?: string | null;
  callerUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Upsert a feature flag and write an audit_log row capturing the
 * before/after enabled state. Used by the admin PUT endpoint.
 */
export async function upsertFlag(input: UpsertFlagInput): Promise<FeatureFlagView> {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.featureFlag.findUnique({
      where: { key: input.key },
      select: { enabled: true, description: true },
    });

    const updated = await tx.featureFlag.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        enabled: input.enabled,
        description: input.description ?? null,
      },
      update: {
        enabled: input.enabled,
        description: input.description ?? null,
      },
    });

    await writeAuditLog(
      {
        actorUserId: input.callerUserId,
        actorRole: 'ADMIN',
        action: 'admin.feature_flag.upserted',
        targetEntityType: 'feature_flag',
        targetEntityId: input.key,
        before: {
          enabled: previous?.enabled ?? false,
          description: previous?.description ?? null,
        },
        after: {
          enabled: updated.enabled,
          description: updated.description,
        },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      tx
    );

    return rowToView(updated as FeatureFlagRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// isFeatureEnabled — exported for Phase 20+ hot-path gating
// ──────────────────────────────────────────────────────────────────────

/**
 * Read a single flag by key. Returns `false` (default) when the row
 * does not exist — Phase 19's schema defaults new flags to disabled,
 * so unknown flags never accidentally enable a code path. Phase 21+
 * may layer Redis caching on top of this read; the signature is
 * deliberately narrow to keep the call site trivial.
 */
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const row = await prisma.featureFlag.findUnique({
    where: { key },
    select: { enabled: true },
  });
  return row?.enabled ?? false;
}

/**
 * Variant that throws NotFoundError if the flag key isn't registered.
 * Useful in admin tooling that wants to surface "this flag was never
 * declared" rather than silently defaulting to off.
 */
export async function requireFeatureFlag(key: string): Promise<FeatureFlagView> {
  const row = await prisma.featureFlag.findUnique({ where: { key } });
  if (!row) throw new NotFoundError(`Feature flag '${key}' not found`);
  return rowToView(row as FeatureFlagRow);
}
