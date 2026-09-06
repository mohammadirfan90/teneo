-- ============================================================================
-- 20260907000001_applications_and_viewings
-- Phase 12: applications + viewing_requests + application_notes + leases stub
-- (13 §13.2.5, 04 §4.3.4, 05 §5.5).
--
-- Tables:
--   applications         — tenant → room applications with state machine
--   viewing_requests     — proposed slots + confirmation
--   application_notes    — owner-only free-text notes
--   leases               — STUB ONLY; Phase 13 owns the API surface and
--                          DB-row creation; APPROVED application
--                          transition does NOT create a row in Phase 12
--
-- Critical constraints (hand-edited — Prisma can't express partial UNIQUE):
--   1. applications_active_uniq — PARTIAL UNIQUE on
--      (room_id, tenant_user_id) WHERE status IN
--      ('SUBMITTED','SCREENING','VIEWING_SCHEDULED','SHORTLISTED','APPROVED')
--      Prevents duplicate active applications per (room, tenant).
--      Phase 12 service catches P2002 here on POST /applications.
--
--   2. leases_room_active_uniq — PARTIAL UNIQUE on (room_id) WHERE status IN
--      ('DRAFT','SIGNED','ACTIVE'). Prevents two open leases for the same
--      room; Phase 13 will rely on this when activating an approved app.
-- ============================================================================

-- ── Enum types ───────────────────────────────────────────────────────────
CREATE TYPE "ApplicationStatus" AS ENUM ('SUBMITTED','SCREENING','VIEWING_SCHEDULED','SHORTLISTED','APPROVED','REJECTED','WITHDRAWN','CANCELLED');
CREATE TYPE "ViewingStatus"     AS ENUM ('REQUESTED','CONFIRMED','COMPLETED','CANCELLED');
CREATE TYPE "LeaseStatus"       AS ENUM ('DRAFT','SIGNED','ACTIVE','ENDED','TERMINATED');
CREATE TYPE "UtilitySplitMode"  AS ENUM ('EQUAL','PROPORTIONAL','CUSTOM');

-- ── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE "applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "tenant_user_id" UUID NOT NULL,
    "message" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "viewing_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID,
    "room_id" UUID NOT NULL,
    "tenant_user_id" UUID NOT NULL,
    "proposed_slots" TIMESTAMPTZ(6)[] NOT NULL,
    "confirmed_slot" TIMESTAMPTZ(6),
    "status" "ViewingStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "viewing_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "application_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "primary_tenant_user_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "rent_minor" BIGINT NOT NULL,
    "deposit_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "late_fee_policy" JSONB,
    "utility_split_mode" "UtilitySplitMode" NOT NULL DEFAULT 'EQUAL',
    "status" "LeaseStatus" NOT NULL DEFAULT 'DRAFT',
    "signed_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "contract_object_key" TEXT,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "leases_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (Prisma-tracked) ─────────────────────────────────────────────
CREATE INDEX "applications_room_status_idx"     ON "applications"("room_id", "status");
CREATE INDEX "applications_tenant_status_idx"  ON "applications"("tenant_user_id", "status");
CREATE INDEX "applications_decided_by_idx"     ON "applications"("decided_by_user_id");

CREATE INDEX "viewing_requests_room_status_idx"    ON "viewing_requests"("room_id", "status");
CREATE INDEX "viewing_requests_tenant_status_idx" ON "viewing_requests"("tenant_user_id", "status");

CREATE INDEX "application_notes_app_idx" ON "application_notes"("application_id", "created_at" DESC);

CREATE INDEX "leases_room_status_idx"   ON "leases"("room_id", "status");
CREATE INDEX "leases_owner_status_idx"  ON "leases"("owner_user_id", "status");

-- ── Indexes (hand-edited partial UNIQUE + supporting) ────────────────────
-- CRITICAL: prevents duplicate active applications for the same
-- (room, tenant). Phase 12 service catches P2002 on POST /applications.
CREATE UNIQUE INDEX "applications_active_uniq"
    ON "applications"("room_id", "tenant_user_id")
    WHERE "status" IN ('SUBMITTED','SCREENING','VIEWING_SCHEDULED','SHORTLISTED','APPROVED');

-- Prevents two open leases for the same room. Phase 13's lease
-- activation will rely on this.
CREATE UNIQUE INDEX "leases_room_active_uniq"
    ON "leases"("room_id")
    WHERE "status" IN ('DRAFT','SIGNED','ACTIVE');

-- Speeds up end-of-lease queries for active leases (cron-style jobs).
CREATE INDEX "leases_end_date_active_idx"
    ON "leases"("end_date")
    WHERE "status" = 'ACTIVE';

-- ── Foreign keys ─────────────────────────────────────────────────────────
ALTER TABLE "applications"
    ADD CONSTRAINT "applications_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE;

ALTER TABLE "applications"
    ADD CONSTRAINT "applications_tenant_user_id_fkey"
    FOREIGN KEY ("tenant_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "applications"
    ADD CONSTRAINT "applications_decided_by_user_id_fkey"
    FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "viewing_requests"
    ADD CONSTRAINT "viewing_requests_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL;

ALTER TABLE "viewing_requests"
    ADD CONSTRAINT "viewing_requests_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE;

ALTER TABLE "viewing_requests"
    ADD CONSTRAINT "viewing_requests_tenant_user_id_fkey"
    FOREIGN KEY ("tenant_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "application_notes"
    ADD CONSTRAINT "application_notes_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE;
