-- ============================================================================
-- 20260905171600_init_identity
-- Phase 3: identity + KYC + audit tables.
--
-- Hand-edited extensions to the Prisma-generated migration:
--   1. CREATE EXTENSION citext — needed for users.email.
--   2. Partial unique indexes that Prisma can't express natively:
--        users(email)              WHERE deleted_at IS NULL
--        users(oauth_provider,
--              oauth_subject)       WHERE oauth_provider IS NOT NULL
--        kyc_submissions(user_id,
--                        role)      WHERE status IN ('PENDING','APPROVED')
--   3. Append-only enforcement on audit_logs via BEFORE UPDATE/DELETE
--      triggers that raise unless the session opts in with
--      `SET LOCAL audit.allow_mutation = 'on'`. The retention /
--      archival job (added in phase 22) uses that opt-in.
-- ============================================================================

-- Enable citext (case-insensitive text). Built into stock Postgres 16 image.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TENANT', 'OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('FEMALE', 'MALE', 'NONBINARY', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KycSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "phone" TEXT,
    "phone_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT,
    "oauth_provider" TEXT,
    "oauth_subject" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" TEXT,
    "gender" "Gender",
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "bio" TEXT,
    "avatar_object_key" TEXT,
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'NONE',
    "kyc_badge_granted_at" TIMESTAMPTZ(6),
    "reputation_score" DECIMAL(4,2),
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "owner_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "bio" TEXT,
    "avatar_object_key" TEXT,
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'NONE',
    "kyc_badge_granted_at" TIMESTAMPTZ(6),
    "reputation_score" DECIMAL(4,2),
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "status" "KycSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "document_object_keys" TEXT[],
    "review_notes" TEXT,
    "reviewer_user_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "doc_hash" TEXT,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kyc_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "target_entity_type" TEXT,
    "target_entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" TEXT,
    "ip" INET,
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- users.status filter (admin queries, login throttle).
CREATE INDEX "users_status_idx" ON "users"("status", "deleted_at");

-- Partial unique on users.email (anonymized-on-delete pattern, 04 §4.9):
-- a soft-deleted row's email is anonymized, so a fresh signup can reuse
-- it without colliding with the tombstone.
CREATE UNIQUE INDEX "users_email_active_uniq"
    ON "users"("email")
    WHERE "deleted_at" IS NULL;

-- Partial unique on (oauth_provider, oauth_subject) — only enforced when
-- oauth_provider is set so password-only users don't conflict.
CREATE UNIQUE INDEX "users_oauth_uniq"
    ON "users"("oauth_provider", "oauth_subject")
    WHERE "oauth_provider" IS NOT NULL;

CREATE INDEX "user_roles_role_idx" ON "user_roles"("role");
CREATE UNIQUE INDEX "user_roles_user_id_role_uniq" ON "user_roles"("user_id", "role");

CREATE UNIQUE INDEX "owner_profiles_user_id_uniq" ON "owner_profiles"("user_id");
CREATE UNIQUE INDEX "tenant_profiles_user_id_uniq" ON "tenant_profiles"("user_id");

CREATE INDEX "kyc_submissions_lookup_idx" ON "kyc_submissions"("user_id", "role", "status");

-- Partial unique on (user_id, role) for active submissions only
-- (04 §4.3.8: at most one active submission per (user, role)).
CREATE UNIQUE INDEX "kyc_submissions_active_uniq"
    ON "kyc_submissions"("user_id", "role")
    WHERE "status" IN ('PENDING', 'APPROVED');

CREATE INDEX "audit_logs_actor_idx" ON "audit_logs"("actor_user_id", "occurred_at" DESC);
CREATE INDEX "audit_logs_target_idx" ON "audit_logs"("target_entity_type", "target_entity_id");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action", "occurred_at");

CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens"("user_id");
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family_id");

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_profiles"
    ADD CONSTRAINT "owner_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_profiles"
    ADD CONSTRAINT "tenant_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kyc_submissions"
    ADD CONSTRAINT "kyc_submissions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Audit-log immutability (04 §4.3.7)
--
-- Block UPDATE/DELETE on audit_logs unless the session has explicitly
-- opted in via `SET LOCAL audit.allow_mutation = 'on'`. The retention
-- archival job (phase 22) uses that opt-in to detach old partitions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('audit.allow_mutation', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION
            'audit_logs is append-only (table=%, op=%)', TG_TABLE_NAME, TG_OP
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

CREATE TRIGGER audit_logs_no_update
    BEFORE UPDATE ON "audit_logs"
    FOR EACH ROW
    EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_delete
    BEFORE DELETE ON "audit_logs"
    FOR EACH ROW
    EXECUTE FUNCTION audit_logs_block_mutation();
