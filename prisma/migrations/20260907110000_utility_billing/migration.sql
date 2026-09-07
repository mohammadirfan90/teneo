-- ============================================================================
-- 20260907110000_utility_billing
-- Phase 16: utility meters + readings + bills + bill-shares (13 §13.2.6,
-- 05 §5.3, 04 §4.3.5).
--
-- New tables (4):
--   property_meters  — one row per physical meter installed on a property.
--                      Carries utility_type, rate_per_unit_minor snapshot,
+                      unit_label, currency, is_active.
--   meter_readings   — append-only readings. UNIQUE(meter_id, reading_date)
--                      prevents duplicate submissions for the same date.
--   utility_bills    — created by POST /bills/generate. Snapshots
--                      previous + current readings so a bill is self-
--                      contained for audit + replay. `superseded=true`
--                      flags rows excluded from the rent-invoice sum.
--   bill_shares      — one per tenant per bill. Σ share_minor ==
--                      utility_bill.total_amount_minor EXACTLY (largest-
--                      remainder invariant from bill-splitter.ts).
--
-- Phase 14's rent_invoices.utility_share_minor is populated by summing
-- the BillShare rows for the invoice's lease tenants on every
-- /bills/generate call.
--
-- Critical constraints (hand-edited):
--   meter_readings_meter_date_uq — UNIQUE(meter_id, reading_date). TRUE
--                                  unique (not partial) since every
--                                  reading has a date.
--
-- Alter on existing tables:
--   leases.utility_split_custom_percents  — Json? JSONB for CUSTOM-mode
--                                           percentages per tenant.
-- ============================================================================

-- ── Enum types ──────────────────────────────────────────────────────────
CREATE TYPE "UtilityType" AS ENUM (
    'WATER',
    'ELECTRICITY',
    'GAS',
    'INTERNET'
);

-- ── Tables ──────────────────────────────────────────────────────────────

CREATE TABLE "property_meters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID NOT NULL,
    "utility_type" "UtilityType" NOT NULL,
    "label" TEXT NOT NULL,
    "rate_per_unit_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "unit_label" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "property_meters_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meter_readings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "meter_id" UUID NOT NULL,
    "reading_date" DATE NOT NULL,
    "reading_value" DECIMAL(12, 4) NOT NULL,
    "notes" TEXT,
    "submitted_by_user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "utility_bills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "previous_reading_value" DECIMAL(12, 4) NOT NULL,
    "current_reading_value" DECIMAL(12, 4) NOT NULL,
    "consumption_units" DECIMAL(12, 4) NOT NULL,
    "total_amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',

    CONSTRAINT "utility_bills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bill_shares" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bill_id" UUID NOT NULL,
    "tenant_user_id" UUID NOT NULL,
    "share_minor" BIGINT NOT NULL,
    "split_mode" VARCHAR(16) NOT NULL,
    "weight_used" DECIMAL(5, 2),
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "bill_shares_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (Prisma-tracked — also listed in schema.prisma) ──────────────
CREATE INDEX "meters_property_active_idx"
    ON "property_meters"("property_id", "is_active");
CREATE INDEX "meters_property_type_idx"
    ON "property_meters"("property_id", "utility_type");
CREATE INDEX "readings_meter_date_idx"
    ON "meter_readings"("meter_id", "reading_date" DESC);
CREATE INDEX "utility_bills_lease_period_idx"
    ON "utility_bills"("lease_id", "period_start");
CREATE INDEX "utility_bills_meter_period_idx"
    ON "utility_bills"("meter_id", "period_start");
CREATE INDEX "bill_shares_bill_idx"
    ON "bill_shares"("bill_id");
CREATE INDEX "bill_shares_tenant_idx"
    ON "bill_shares"("tenant_user_id", "created_at" DESC);

-- ── Indexes (hand-edited — UNIQUE constraint for reading idempotency) ───
-- Source of truth for "only one reading per (meter, date)". The service
-- layer's P2002 catch (Prisma unique-violation) reads this name when
-- re-fetching the winning row for the race-loser branch.
CREATE UNIQUE INDEX "meter_readings_meter_date_uq"
    ON "meter_readings"("meter_id", "reading_date");

-- ── Foreign keys ────────────────────────────────────────────────────────
ALTER TABLE "property_meters"
    ADD CONSTRAINT "property_meters_property_id_fkey"
    FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT;

ALTER TABLE "meter_readings"
    ADD CONSTRAINT "meter_readings_meter_id_fkey"
    FOREIGN KEY ("meter_id") REFERENCES "property_meters"("id") ON DELETE RESTRICT;

ALTER TABLE "meter_readings"
    ADD CONSTRAINT "meter_readings_submitted_by_user_id_fkey"
    FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

ALTER TABLE "utility_bills"
    ADD CONSTRAINT "utility_bills_lease_id_fkey"
    FOREIGN KEY ("lease_id") REFERENCES "leases"("id") ON DELETE RESTRICT;

ALTER TABLE "utility_bills"
    ADD CONSTRAINT "utility_bills_meter_id_fkey"
    FOREIGN KEY ("meter_id") REFERENCES "property_meters"("id") ON DELETE RESTRICT;

ALTER TABLE "bill_shares"
    ADD CONSTRAINT "bill_shares_bill_id_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "utility_bills"("id") ON DELETE CASCADE;

ALTER TABLE "bill_shares"
    ADD CONSTRAINT "bill_shares_tenant_user_id_fkey"
    FOREIGN KEY ("tenant_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- ── Alter leases for CUSTOM-split percentages ──────────────────────────
ALTER TABLE "leases"
    ADD COLUMN "utility_split_custom_percents" JSONB;