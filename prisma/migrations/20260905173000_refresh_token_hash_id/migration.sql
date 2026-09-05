-- Phase 6 correction: refresh_tokens.id holds sha256(raw_token) hex (64 chars),
-- not a UUID. Drop the existing UUID primary key column and replace it with
-- a TEXT primary key. No data is lost — refresh tokens minted before this
-- migration are unusable either way (no rows exist yet on dev).

ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_pkey";
ALTER TABLE "refresh_tokens" ALTER COLUMN "id" TYPE TEXT USING "id"::text;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id");
