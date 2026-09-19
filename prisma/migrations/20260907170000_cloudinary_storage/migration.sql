-- ============================================================================
-- 20260907170000_cloudinary_storage
-- Real object storage: Cloudinary replaces the `https://stub.local/…`
-- placeholders that Phase 18 shipped for documents and room photos.
--
-- New tables (1):
--   room_photos              — one row per uploaded listing image. This
--                              table never existed, which is why
--                              DELETE /rooms/:id/photos/:photo_id and
--                              POST  /rooms/:id/photos/:photo_id/reorder
--                              were 501 stubs: there was nowhere to
--                              record a photo, so there was nothing to
--                              delete or reorder.
--
-- Altered tables (1):
--   documents                — +4 columns describing where the bytes
--                              actually live. `object_key` keeps its
--                              name but now holds a Cloudinary
--                              public_id rather than an invented key.
--
-- Delivery model (mirrors src/lib/cloudinary.ts):
--   documents.delivery_type   = 'authenticated'  → private; GET /:id/url
--                               mints a signed URL that expires in 15m.
--   room_photos.delivery_type = 'upload'         → public CDN; listing
--                               photos are meant to be anonymously
--                               fetchable once the room is PUBLISHED.
--
-- Ordering (`room_photos.position`):
--   Deliberately NOT uniquely constrained per room. Reordering rewrites
--   several rows in one transaction and passes through intermediate
--   states where two rows briefly share a position; a plain UNIQUE index
--   would abort mid-transaction and would need to be DEFERRABLE to work.
--   Ordering is normalised in service code instead (0..n-1, no gaps).
--
-- Foreign keys (2):
--   room_photos → rooms  CASCADE  (photos die with the room)
--   room_photos → users  CASCADE  (uploader account removal clears them)
--
-- Backfill:
--   Existing `documents` rows were minted by the stub and point at
--   objects that were never uploaded anywhere. They are marked
--   storage_provider='stub' so the download route can return a clear
--   410 GONE instead of asking Cloudinary for an asset it never had.
-- ============================================================================

-- ── documents: describe where the bytes actually live ──────────────────
ALTER TABLE "documents"
  ADD COLUMN "storage_provider" VARCHAR(24) NOT NULL DEFAULT 'cloudinary',
  ADD COLUMN "resource_type"    VARCHAR(16) NOT NULL DEFAULT 'image',
  ADD COLUMN "delivery_type"    VARCHAR(16) NOT NULL DEFAULT 'authenticated',
  ADD COLUMN "etag"             VARCHAR(64);

-- Rows created before this migration were stub URLs with no real object
-- behind them. Tag them so reads can fail loudly rather than 404 from
-- Cloudinary with a confusing message.
UPDATE "documents" SET "storage_provider" = 'stub' WHERE "created_at" < NOW();

-- ── room_photos ────────────────────────────────────────────────────────
CREATE TABLE "room_photos" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "room_id"             UUID         NOT NULL,
  "uploaded_by_user_id" UUID         NOT NULL,
  "public_id"           TEXT         NOT NULL,
  "secure_url"          TEXT         NOT NULL,
  "storage_provider"    VARCHAR(24)  NOT NULL DEFAULT 'cloudinary',
  "resource_type"       VARCHAR(16)  NOT NULL DEFAULT 'image',
  "delivery_type"       VARCHAR(16)  NOT NULL DEFAULT 'upload',
  "content_type"        TEXT         NOT NULL,
  "size_bytes"          BIGINT       NOT NULL,
  "width"               INTEGER,
  "height"              INTEGER,
  "etag"                VARCHAR(64),
  "position"            INTEGER      NOT NULL DEFAULT 0,
  "alt"                 TEXT,
  "tenant_id"           UUID         NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deleted_at"          TIMESTAMPTZ(6),

  CONSTRAINT "room_photos_pkey" PRIMARY KEY ("id")
);

-- Gallery reads are always "photos of one room, in order".
CREATE INDEX "room_photos_room_position_idx"
  ON "room_photos" ("room_id", "position");

-- Reverse lookup from a Cloudinary webhook / cleanup job.
CREATE INDEX "room_photos_public_id_idx"
  ON "room_photos" ("public_id");

-- A given Cloudinary asset belongs to exactly one live photo row. Partial
-- so a re-upload after a delete can reuse a public_id if it ever needs to.
CREATE UNIQUE INDEX "room_photos_public_id_live_uq"
  ON "room_photos" ("public_id")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "room_photos"
  ADD CONSTRAINT "room_photos_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "rooms"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "room_photos"
  ADD CONSTRAINT "room_photos_uploaded_by_user_id_fkey"
  FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
