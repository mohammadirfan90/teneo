-- ============================================================================
-- 20260907100000_payments
-- Phase 15: Stripe PaymentIntent + webhook (07 §7.4, 13 §13.2.7, 04 §4.3.6).
--
-- New table:
--   payments — one row per Stripe PaymentIntent attempt. Phase 14's
--              rent_invoices gain a back-relation via "payments" array;
--              the FK on payments.invoice_id has ON DELETE RESTRICT.
--
-- Idempotency strategy (3 layers):
--   1. payments_idempotency_key_uq       — TRUE UNIQUE on idempotency_key
--                                          catches caller-driven duplicate
--                                          POST /payments/stripe/intent calls.
--   2. payments_gateway_intent_uq        — PARTIAL UNIQUE on (gateway,
--                                          gateway_payment_intent_id) WHERE
--                                          gateway_payment_intent_id IS NOT
--                                          NULL, catches webhook duplicates
--                                          before the row is re-read.
--   3. Redis SET NX EX 86400 stripe:webhook:seen:{event.id} — surface-
--                                          level dedup at the webhook route
--                                          (in payments.controller.ts).
--
-- Hand-edited indexes (Prisma doesn't model partial uniques):
--   payments_idempotency_key_uq       — full UNIQUE
--   payments_gateway_intent_uq        — partial UNIQUE WHERE NOT NULL
--   payments_gateway_charge_idx       — partial non-unique (for
--                                       charge.refunded lookup)
--
-- Denormalization:
--   payments.lease_id is denormalized from rent_invoices.lease_id so the
--   hot path /payments/me can index-scan by tenant_user_id without
--   joining rent_invoices. Currency also denormalized.
--
-- FK ON DELETE RESTRICT policy preserves the audit trail (payments must
-- outlive their invoice/lease).
-- ============================================================================

-- ── Enum types ──────────────────────────────────────────────────────────
CREATE TYPE "PaymentGateway" AS ENUM (
    'STRIPE'
);

CREATE TYPE "PaymentStatus" AS ENUM (
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'REFUNDED'
);

-- ── Tables ──────────────────────────────────────────────────────────────

CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "lease_id" UUID NOT NULL,
    "tenant_user_id" UUID NOT NULL,
    "gateway" "PaymentGateway" NOT NULL DEFAULT 'STRIPE',
    "gateway_payment_intent_id" TEXT,
    "gateway_charge_id" TEXT,
    "gateway_refund_id" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "refunded_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PROCESSING',
    "idempotency_key" TEXT NOT NULL,
    "failure_code" TEXT,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (Prisma-tracked — also listed in schema.prisma) ──────────────
CREATE INDEX "payments_invoice_status_idx"
    ON "payments"("invoice_id", "status");
CREATE INDEX "payments_tenant_idx"
    ON "payments"("tenant_user_id", "created_at" DESC);
CREATE INDEX "payments_status_idx"
    ON "payments"("status", "created_at");

-- ── Indexes (hand-edited — UNIQUE constraints + partial lookups) ────────
--
-- TRUE UNIQUE on idempotency_key. The service layer (payments.service.ts)
-- pre-checks via findUnique({ where: { idempotency_key } }); a P2002 on
-- create() catches the race.
CREATE UNIQUE INDEX "payments_idempotency_key_uq"
    ON "payments"("idempotency_key");

-- PARTIAL UNIQUE on (gateway, gateway_payment_intent_id) WHERE NOT NULL.
-- Catches the webhook race where Stripe duplicates an event before the
-- payment row is fully populated with the PI id. Source of truth for
-- "at most one local row per Stripe PaymentIntent".
CREATE UNIQUE INDEX "payments_gateway_intent_uq"
    ON "payments"("gateway", "gateway_payment_intent_id")
    WHERE "gateway_payment_intent_id" IS NOT NULL;

-- Partial non-unique index on gateway_charge_id for charge.refunded
-- lookups. Most rows (failed intents) have no charge id, so the partial
-- predicate keeps the index small.
CREATE INDEX "payments_gateway_charge_idx"
    ON "payments"("gateway_charge_id")
    WHERE "gateway_charge_id" IS NOT NULL;

-- ── Foreign keys ────────────────────────────────────────────────────────
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "rent_invoices"("id") ON DELETE RESTRICT;

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_lease_id_fkey"
    FOREIGN KEY ("lease_id") REFERENCES "leases"("id") ON DELETE RESTRICT;

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_tenant_user_id_fkey"
    FOREIGN KEY ("tenant_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
