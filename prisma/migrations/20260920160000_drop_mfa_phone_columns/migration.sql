-- No MFA or phone-verification flow exists; these columns were only ever
-- written as NULL, and mfa_enabled was read into req.user and never checked.
ALTER TABLE "users"
  DROP COLUMN "phone_verified_at",
  DROP COLUMN "mfa_enabled",
  DROP COLUMN "mfa_secret";
