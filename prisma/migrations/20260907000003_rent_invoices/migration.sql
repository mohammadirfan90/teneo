-- ============================================================================
-- 20260907000003_rent_invoices
-- Phase 14: rent invoice generation (13 §13.2.6, 05 §5.2, 04 §4.3.4, 03 §3.4).
--
-- New table:
--   rent_invoices — one row per (lease_id, period_start). UNIQUE
--                   (lease_id, period_start) gives idempotency for
--                   POST /bills/generate. utility_share_minor is always
--                   0 in Phase 14; Phase 16 (utility meters + bill-split)
--                   will populate it. Inline dispute + waive columns
--                   (one open dispute per invoice by state-machine).
--
-- Drops:
--   leases.tenant_id — per Phase 13 TODO comment, Phase 14 cleans it up.
--   The column had a NOT NULL DEFAULT '00000000-...' so the drop is
--   safe (no rows have NULL; the constant means existing rows just lose
--   the column).
--
-- Critical constraints (hand-edited):
--   rent_invoices_lease_period_uq — UNIQUE(lease_id, period_start). NOT
--                                   a partial unique — the state machine
--                                   guarantees at most one row per period.
--   rent_invoices_status_due_idx — composite (status, due_date) for the
--                                   Phase 17 cron that flips DUE → OVERDUE.
--   rent_invoices_status_generated_idx — composite (status, generated_at)
--                                   for cursor pagination of /invoices/me.
-- ============================================================================

-- ── Enum types ───────────────────────────────────────────────────────────
CREATE TYPE "InvoiceStatus" AS ENUM (
    'DUE',
    'PARTIALLY_PAID',
    'PAID',
    'OVERDUE',
    'WAIVED',
    'DISPUTED'
);

-- ── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE "rent_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "base_rent_minor" BIGINT NOT NULL,
    "utility_share_minor" BIGINT NOT NULL DEFAULT 0,
    "late_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DUE',
    "due_date" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "disputed_at" TIMESTAMPTZ(6),
    "disputed_by_user_id" UUID,
    "dispute_reason" TEXT,
    "waived_at" TIMESTAMPTZ(6),
    "waived_by_user_id" UUID,
    "waive_reason" TEXT,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "rent_invoices_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (Prisma-tracked — also listed in schema.prisma) ──────────────
CREATE INDEX "rent_invoices_lease_status_idx"
    ON "rent_invoices"("lease_id", "status");
CREATE INDEX "rent_invoices_status_due_idx"
    ON "rent_invoices"("status", "due_date");
CREATE INDEX "rent_invoices_status_generated_idx"
    ON "rent_invoices"("status", "generated_at");

-- ── Indexes (hand-edited — UNIQUE constraint for idempotency) ────────────
-- Source of truth for "only one invoice per (lease, period_start)". The
-- service layer's P2002 catch (Prisma unique-violation) reads this name
-- when re-fetching the winning row for the race-loser branch.
CREATE UNIQUE INDEX "rent_invoices_lease_period_uq"
    ON "rent_invoices"("lease_id", "period_start");

-- ── Foreign keys ─────────────────────────────────────────────────────────
ALTER TABLE "rent_invoices"
    ADD CONSTRAINT "rent_invoices_lease_id_fkey"
    FOREIGN KEY ("lease_id") REFERENCES "leases"("id") ON DELETE RESTRICT;

ALTER TABLE "rent_invoices"
    ADD CONSTRAINT "rent_invoices_disputed_by_user_id_fkey"
    FOREIGN KEY ("disputed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "rent_invoices"
    ADD CONSTRAINT "rent_invoices_waived_by_user_id_fkey"
    FOREIGN KEY ("waived_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- ── Drop leases.tenant_id (Phase 13 TODO cleanup) ────────────────────────
-- Safe: column is NOT NULL with a DEFAULT, so the drop doesn't touch any
-- row. No FK reference exists (only the column itself, which we added in
-- Phase 12 and have not used as a FK target anywhere).
ALTER TABLE "leases" DROP COLUMN "tenant_id";
