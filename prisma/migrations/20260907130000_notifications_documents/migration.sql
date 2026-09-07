-- ============================================================================
-- 20260907130000_notifications_documents
-- Phase 18: notifications + notification preferences + documents
-- (04 §4.3.7, 05 §5.8, 13 §13.2.8).
--
-- New tables (3):
--   notifications              — one row per delivered event landing in
--                                the in-app feed. Backed by
--                                notifications.emit() helper called
--                                from inside the originating module's
--                                prisma.$transaction.
--   notification_preferences   — per-user channel preferences keyed by
--                                eventType. One row per user.
--   documents                  — owned storage objects. Phase 18
--                                returns stub URLs (15-min expiry);
--                                Phase 19+ replaces with real S3
--                                signed URLs.
--
-- Enums (2):
--   NotificationChannel         — IN_APP | EMAIL
--   NotificationEventType       — closed-set covering ≈30 outbox
--                                 event_types shipped by Phases 9-17.
--                                 Must be extended in lockstep with
--                                 new event_types in Phase 19+.
--
-- Critical constraints (hand-edited):
--   notifications_recipient_source_uq — PARTIAL UNIQUE
--                                       (recipient_user_id, source_event_id)
--                                       WHERE source_event_id IS NOT NULL.
--                                       Emits with the same source
--                                       outbox_event row are
--                                       idempotent at the DB level
--                                       (caught via the same P2002 +
--                                       pre-check pattern used by
--                                       Phase 14 invoices + Phase 15
--                                       payments).
--
-- Foreign keys (3):
--   notification → recipient user  Cascade  (feeds die with the user)
--   preference  → user             Cascade
--   document    → owner user       Cascade  (PII cleanup)
-- ============================================================================

-- ── Enum types ──────────────────────────────────────────────────────────
CREATE TYPE "NotificationChannel" AS ENUM (
    'IN_APP',
    'EMAIL'
);

CREATE TYPE "NotificationEventType" AS ENUM (
    -- KYC (Phase 9)
    'KYC_APPROVED',
    'KYC_REJECTED',
    'KYC_REQUEST_INFO',
    -- Properties (Phase 10)
    'PROPERTY_PUBLISHED',
    'PROPERTY_SOFT_DELETED',
    'ROOM_PUBLISHED',
    -- Applications + viewings (Phase 12)
    'APPLICATION_RECEIVED',
    'APPLICATION_APPROVED',
    'APPLICATION_STATUS_CHANGED',
    'VIEWING_REQUESTED',
    'VIEWING_CONFIRMED',
    -- Leases (Phase 13)
    'LEASE_DRAFT_CREATED',
    'LEASE_SIGNED',
    'LEASE_PARTIAL_SIGNATURE',
    'LEASE_ACTIVATED',
    'LEASE_STATUS_CHANGED',
    'LEASE_TERMINATED',
    'LEASE_AMENDMENT_PROPOSED',
    'LEASE_AMENDMENT_SIGNED',
    -- Invoices (Phase 14)
    'INVOICE_GENERATED',
    'INVOICE_WAIVED',
    'INVOICE_STATUS_CHANGED',
    'INVOICE_PAID',
    -- Payments (Phase 15)
    'PAYMENT_PROCESSING',
    'PAYMENT_SUCCEEDED',
    'PAYMENT_FAILED',
    'PAYMENT_REFUND_REQUESTED',
    'PAYMENT_REFUNDED',
    'PAYMENT_PARTIAL_REFUND',
    -- Meters + bills (Phase 16)
    'METER_CREATED',
    'METER_READING_SUBMITTED',
    'UTILITY_BILL_GENERATED',
    -- Tickets (Phase 17)
    'TICKET_CREATED',
    'TICKET_TRANSITION',
    'TICKET_RATED'
);

-- ── Tables ──────────────────────────────────────────────────────────────

CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient_user_id" UUID NOT NULL,
    "event_type" "NotificationEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "source_event_id" UUID,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(6),
    "channels" "NotificationChannel"[] NOT NULL DEFAULT ARRAY['IN_APP']::"NotificationChannel"[],
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "channel_event_map" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_user_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "label" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (Prisma-tracked) ────────────────────────────────────────────

CREATE INDEX "notifications_feed_idx"
    ON "notifications" ("recipient_user_id", "read", "created_at" DESC);

CREATE INDEX "documents_owner_status_idx"
    ON "documents" ("owner_user_id", "status");

CREATE INDEX "documents_object_key_idx"
    ON "documents" ("object_key");

-- ── Indexes (hand-edited) ──────────────────────────────────────────────

-- Idempotency: repeat emits with the same source_event_id for the
-- same recipient must not double-row. Partial UNIQUE keeps null
-- rows allowed (Phase 19 emits that don't carry sourceEventId go
-- through with no uniqueness check).
CREATE UNIQUE INDEX "notifications_recipient_source_uq"
    ON "notifications" ("recipient_user_id", "source_event_id")
    WHERE "source_event_id" IS NOT NULL;

-- ── Foreign keys ────────────────────────────────────────────────────────

-- notification → recipient user (cascade)
ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

-- preference → user (cascade)
ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

-- document → owner user (cascade)
ALTER TABLE "documents"
    ADD CONSTRAINT "documents_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
