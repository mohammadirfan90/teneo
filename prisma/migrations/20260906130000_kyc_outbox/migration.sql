-- ============================================================================
-- 20260906130000_kyc_outbox
-- Phase 9: KYC submission admin-review additions + transactional outbox.
--
--   1. New `flagged_for_review` column on `kyc_submissions` — set when
--      the docHash matches another user's submission (cross-user dup).
--   2. `kyc_submissions_doc_hash_idx` — supports the duplicate check.
--   3. New `outbox_events` table for transactional event emission.
-- ============================================================================

-- 1. kyc_submissions.flagged_for_review ---------------------------------------
ALTER TABLE "kyc_submissions"
    ADD COLUMN "flagged_for_review" BOOLEAN NOT NULL DEFAULT false;

-- 2. doc_hash lookup index ---------------------------------------------------
CREATE INDEX "kyc_submissions_doc_hash_idx"
    ON "kyc_submissions" ("doc_hash")
    WHERE "doc_hash" IS NOT NULL;

-- 3. outbox_events table -----------------------------------------------------
CREATE TABLE "outbox_events" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "event_type"   TEXT         NOT NULL,
    "payload"      JSONB        NOT NULL,
    "dispatched"   BOOLEAN      NOT NULL DEFAULT false,
    "dispatched_at" TIMESTAMPTZ,
    "attempts"     INTEGER      NOT NULL DEFAULT 0,
    "last_error"   TEXT,
    "tenant_id"    UUID         NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_events_dispatch_idx"
    ON "outbox_events" ("dispatched", "created_at");

CREATE INDEX "outbox_events_type_idx"
    ON "outbox_events" ("event_type", "created_at");
