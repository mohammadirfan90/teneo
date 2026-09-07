-- ============================================================================
-- 20260907150000_match_results_intro_requests
-- Phase 20: roommate matching (lite) (13 §13.2.4, 05 §5.1).
--
-- New tables (2):
--   match_results    — one row per (caller, candidate) pair from
--                      POST /match/run. Stores the composite score
--                      in [0, 100], the per-dimension breakdown, a
--                      human-readable explain string, and the rank
--                      within that run.
--   intro_requests   — mutual-intro lifecycle. callerAcceptedAt +
--                      candidateAcceptedAt: both must be set for
--                      revealedAt to flip. Until then contact info
--                      is hidden from both parties.
--
-- Indexes (3 Prisma + 1 hand-edited):
--   match_results_caller_candidate_uq  — UNIQUE (caller, candidate)
--                                         lets a re-run upsert cleanly.
--   match_results_caller_rank_idx      — (caller, rank asc) so
--                                         GET /match/results is O(top-20).
--   intro_requests_match_uq            — UNIQUE (match_result_id)
--                                         one intro per match.
--   intro_requests_caller_idx          — (caller, createdAt desc)
--   intro_requests_candidate_idx       — (candidate, createdAt desc)
--
-- FKs (4): all CASCADE because matches + intros are personal data that
-- should die with the user (matches Phase 19's admin takedown pattern).
-- ============================================================================

CREATE TABLE match_results (
  id                UUID         NOT NULL DEFAULT gen_random_uuid(),
  caller_user_id    UUID         NOT NULL,
  candidate_user_id UUID         NOT NULL,
  score             INTEGER      NOT NULL,
  breakdown         JSONB        NOT NULL,
  explain           TEXT         NOT NULL,
  rank              INTEGER      NOT NULL,
  tenant_id         UUID         NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT match_results_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX match_results_caller_candidate_uq
  ON match_results (caller_user_id, candidate_user_id);

CREATE INDEX match_results_caller_rank_idx
  ON match_results (caller_user_id, rank);

ALTER TABLE match_results
  ADD CONSTRAINT match_results_caller_fk
    FOREIGN KEY (caller_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE match_results
  ADD CONSTRAINT match_results_candidate_fk
    FOREIGN KEY (candidate_user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE TABLE intro_requests (
  id                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  match_result_id       UUID         NOT NULL,
  caller_user_id        UUID         NOT NULL,
  candidate_user_id     UUID         NOT NULL,
  caller_accepted_at    TIMESTAMPTZ  NULL,
  candidate_accepted_at TIMESTAMPTZ  NULL,
  revealed_at           TIMESTAMPTZ  NULL,
  declined_at           TIMESTAMPTZ  NULL,
  tenant_id             UUID         NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT intro_requests_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX intro_requests_match_uq
  ON intro_requests (match_result_id);

CREATE INDEX intro_requests_caller_idx
  ON intro_requests (caller_user_id, created_at DESC);

CREATE INDEX intro_requests_candidate_idx
  ON intro_requests (candidate_user_id, created_at DESC);

ALTER TABLE intro_requests
  ADD CONSTRAINT intro_requests_match_fk
    FOREIGN KEY (match_result_id) REFERENCES match_results(id) ON DELETE CASCADE;
ALTER TABLE intro_requests
  ADD CONSTRAINT intro_requests_caller_fk
    FOREIGN KEY (caller_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE intro_requests
  ADD CONSTRAINT intro_requests_candidate_fk
    FOREIGN KEY (candidate_user_id) REFERENCES users(id) ON DELETE CASCADE;
