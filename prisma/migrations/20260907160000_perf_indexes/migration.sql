-- ---------------------------------------------------------------------------
-- Phase 21: Perf indexes (04 §4.6, 08 §8.4.1)
--
-- Adds the small set of indexes that the SPEC §"Indexes Required" list
-- specifies but aren't already covered by prior migrations. All additions
-- are idempotent (CREATE INDEX IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT
-- EXISTS) so re-running this migration is safe.
--
-- What we add:
--   1. refresh_tokens(expires_at) WHERE revoked_at IS NULL
--      Cleanup-job friendly: lets the rotation worker sweep only the
--      live, un-revoked rows that are about to expire.
--
--   2. UNIQUE bill_shares(bill_id, tenant_user_id)
--      Defends the "one bill-share row per (bill, tenant)" invariant
--      (the bill-share generator is supposed to upsert on conflict
--      anyway; this index just makes the race physically impossible).
--
-- Indexes intentionally NOT added in this phase:
--   - outbox_events(sent_at, occurred_at) WHERE sent_at IS NULL:
--     equivalent to our existing outbox_events_dispatch_idx on
--     (dispatched, created_at). The schema renamed sent_at→dispatched;
--     the dispatch query already uses this index.
--   - room_photos(room_id, position): no room_photos table yet.
--   - preferences_tenant GINs + kyc active UNIQUE: already present from
--     Phase 6 migrations.
--   - all other SPEC items: already present in Phase 6/10/11/12/13/14/16.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "refresh_tokens_expiry_live_idx"
    ON "refresh_tokens" ("expires_at")
    WHERE "revoked_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "bill_shares_bill_tenant_uq"
    ON "bill_shares" ("bill_id", "tenant_user_id");
