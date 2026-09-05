-- Phase 8: tenant preferences sheet per spec §4.3.3.
-- 1:1 with users; lives outside the role-profile because preferences
-- describe what the user is looking for (vs. who they are).
--
-- All optional columns except `visibility` (so we always know whether
-- the user has chosen to be visible at all). GIN indexes on the
-- JSONB lifestyle and TEXT[] preferred_cities for matching.

CREATE TABLE "preferences_tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "budget_min_minor" BIGINT,
    "budget_max_minor" BIGINT,
    "preferred_cities" TEXT[],
    "move_in_from" DATE,
    "move_in_to" DATE,
    "lifestyle" JSONB,
    "interests" TEXT[],
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "preferences_tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "preferences_tenant_user_id_uniq"
    ON "preferences_tenant"("user_id");
CREATE INDEX "preferences_tenant_lifestyle_gin"
    ON "preferences_tenant" USING GIN ("lifestyle");
CREATE INDEX "preferences_tenant_cities_gin"
    ON "preferences_tenant" USING GIN ("preferred_cities");

ALTER TABLE "preferences_tenant"
    ADD CONSTRAINT "preferences_tenant_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
