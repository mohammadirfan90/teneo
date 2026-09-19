-- Schema/database alignment.
--
-- schema.prisma declared @@unique([leaseId, signerUserId], name: "...") for
-- lease_signatures, but on @@unique `name:` sets the Prisma Client alias, not
-- the database constraint name — so the unique index was never created. Two
-- rows for the same signer on the same lease are possible today. The schema
-- now uses `map:`; this creates the index it names.
--
-- Verified before writing: SELECT over lease_signatures grouped by
-- (lease_id, signer_user_id) returns no group with count > 1.
CREATE UNIQUE INDEX "lease_signatures_lease_signer_uq"
  ON "lease_signatures" ("lease_id", "signer_user_id");
