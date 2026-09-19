-- Remove storage for features deleted as dummy or dead code
-- (phases/cleanup-remove-dummies.md). Nothing else references these
-- objects: no inbound foreign keys, no views, and the two enums are
-- used only by "notifications". Plain DROP, no CASCADE: if anything
-- unexpected depends on them, this fails loudly instead of cascading.
DROP TABLE "notifications";
DROP TABLE "notification_preferences";
DROP TABLE "feature_flags";
DROP TABLE "application_notes";
DROP TABLE "outbox_events";
DROP TYPE "NotificationChannel";
DROP TYPE "NotificationEventType";
