-- ============================================================================
-- 20260907140000_admin_feature_flags
-- Phase 19: admin moderation + audit logs + feature flags
-- (09 §9.4–§9.7, 13 §13.2.9).
--
-- New tables (1):
--   feature_flags        — global runtime kill-switches (boolean per key).
--                          Phase 19 ships Admin CRUD + audit_log entries
--                          for every upsert. Phase 21+ may add per-tenant
--                          scoping by relaxing the PK to (tenant_id, key)
--                          without breaking existing reads.
--
-- No new enums. No hand-edited constraints. No FKs (feature_flags is a
-- global lookup table with no parent relationship).
-- ============================================================================

CREATE TABLE feature_flags (
  key         VARCHAR(64) NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT false,
  description TEXT        NULL,
  tenant_id   UUID        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT feature_flags_pkey PRIMARY KEY (key)
);
