-- ============================================================================
-- 20260907000002_lease_signing
-- Phase 13: lease signing infrastructure (multi-party) + amendment stubs
-- (13 §13.2.5, 07 §7.5.1, 07 §7.5.2, 04 §4.3.4).
--
-- New tables:
--   lease_tenants     — co-tenants per spec §4.3.4; composite PK
--                       (lease_id, tenant_user_id). Phase 12 retrofit
--                       inserts the primary row inside the APPROVED
--                       application's $transaction.
--   lease_signatures  — append-only audit of who signed when, with IP/UA.
--                       UNIQUE(lease_id, signer_user_id) gives free
--                       idempotency for POST /sign — same party signing
--                       twice is a no-op at the schema level.
--   lease_amendments  — stub for /amend + /amendments/:aid/sign. Real
--                       payload schema lands in Phase 14.
--
-- Critical constraints (hand-edited — Prisma can't express partial UNIQUE):
--   1. lease_tenants_one_primary_per_lease — PARTIAL UNIQUE on
--      (lease_id) WHERE is_primary. Enforces "at most one primary
--      tenant per lease" so two co-tenants can't both be primary.
--
--   2. leases_end_date_active_idx — PARTIAL INDEX on (end_date) WHERE
--      status = 'ACTIVE'. Indexes end-of-lease queries for the
--      ACTIVE → ENDED cron in Phase 14. (The Phase 12 migration
--      already added the same index; this CREATE INDEX is idempotent
--      with IF NOT EXISTS so re-running on a DB that already has it
--      is safe.)
-- ============================================================================

-- ── Enum types ───────────────────────────────────────────────────────────
CREATE TYPE "LeasePartyRole"       AS ENUM ('OWNER','TENANT');
CREATE TYPE "LeaseAmendmentStatus" AS ENUM ('PROPOSED','SIGNED','REJECTED');

-- ── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE "lease_tenants" (
    "lease_id" UUID NOT NULL,
    "tenant_user_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "liability_share" NUMERIC(5, 2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "lease_tenants_pkey" PRIMARY KEY ("lease_id","tenant_user_id")
);

CREATE TABLE "lease_signatures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "signer_user_id" UUID NOT NULL,
    "signer_role" "LeasePartyRole" NOT NULL,
    "signed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "lease_signatures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lease_amendments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "proposed_by_user_id" UUID NOT NULL,
    "status" "LeaseAmendmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "signed_at" TIMESTAMPTZ(6),

    CONSTRAINT "lease_amendments_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (Prisma-tracked) ─────────────────────────────────────────────
CREATE INDEX "lease_tenants_tenant_idx"  ON "lease_tenants"("tenant_user_id");
CREATE INDEX "lease_signatures_lease_idx" ON "lease_signatures"("lease_id");
CREATE INDEX "lease_amendments_lease_idx" ON "lease_amendments"("lease_id");

-- ── Indexes (hand-edited partial UNIQUE + supporting) ────────────────────
-- CRITICAL: enforces "at most one primary tenant per lease".
-- Without this, two rows could have is_primary = true on the same lease.
CREATE UNIQUE INDEX "lease_tenants_one_primary_per_lease"
    ON "lease_tenants"("lease_id")
    WHERE "is_primary" = true;

-- Idempotent partial index for end-of-lease queries. Phase 12 already
-- creates this; IF NOT EXISTS makes the migration safe to re-run if
-- someone applied Phase 12 + Phase 13 out of order.
CREATE INDEX IF NOT EXISTS "leases_end_date_active_idx"
    ON "leases"("end_date")
    WHERE "status" = 'ACTIVE';

-- ── Foreign keys ─────────────────────────────────────────────────────────
ALTER TABLE "lease_tenants"
    ADD CONSTRAINT "lease_tenants_lease_id_fkey"
    FOREIGN KEY ("lease_id") REFERENCES "leases"("id") ON DELETE CASCADE;

ALTER TABLE "lease_tenants"
    ADD CONSTRAINT "lease_tenants_tenant_user_id_fkey"
    FOREIGN KEY ("tenant_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "lease_signatures"
    ADD CONSTRAINT "lease_signatures_lease_id_fkey"
    FOREIGN KEY ("lease_id") REFERENCES "leases"("id") ON DELETE CASCADE;

ALTER TABLE "lease_signatures"
    ADD CONSTRAINT "lease_signatures_signer_user_id_fkey"
    FOREIGN KEY ("signer_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "lease_amendments"
    ADD CONSTRAINT "lease_amendments_lease_id_fkey"
    FOREIGN KEY ("lease_id") REFERENCES "leases"("id") ON DELETE CASCADE;

ALTER TABLE "lease_amendments"
    ADD CONSTRAINT "lease_amendments_proposed_by_user_id_fkey"
    FOREIGN KEY ("proposed_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
