-- The tenant_id column carried a constant zero UUID on every table and was
-- never filtered on. Single-tenant by design. Plain DROP COLUMN (no
-- CASCADE) so unexpected dependencies fail loudly.
ALTER TABLE "users" DROP COLUMN "tenant_id";
ALTER TABLE "user_roles" DROP COLUMN "tenant_id";
ALTER TABLE "owner_profiles" DROP COLUMN "tenant_id";
ALTER TABLE "tenant_profiles" DROP COLUMN "tenant_id";
ALTER TABLE "kyc_submissions" DROP COLUMN "tenant_id";
ALTER TABLE "audit_logs" DROP COLUMN "tenant_id";
ALTER TABLE "refresh_tokens" DROP COLUMN "tenant_id";
ALTER TABLE "preferences_tenant" DROP COLUMN "tenant_id";
ALTER TABLE "properties" DROP COLUMN "tenant_id";
ALTER TABLE "buildings" DROP COLUMN "tenant_id";
ALTER TABLE "flats" DROP COLUMN "tenant_id";
ALTER TABLE "rooms" DROP COLUMN "tenant_id";
ALTER TABLE "saved_searches" DROP COLUMN "tenant_id";
ALTER TABLE "applications" DROP COLUMN "tenant_id";
ALTER TABLE "viewing_requests" DROP COLUMN "tenant_id";
ALTER TABLE "rent_invoices" DROP COLUMN "tenant_id";
ALTER TABLE "payments" DROP COLUMN "tenant_id";
ALTER TABLE "property_meters" DROP COLUMN "tenant_id";
ALTER TABLE "meter_readings" DROP COLUMN "tenant_id";
ALTER TABLE "utility_bills" DROP COLUMN "tenant_id";
ALTER TABLE "bill_shares" DROP COLUMN "tenant_id";
ALTER TABLE "maintenance_tickets" DROP COLUMN "tenant_id";
ALTER TABLE "maintenance_updates" DROP COLUMN "tenant_id";
ALTER TABLE "documents" DROP COLUMN "tenant_id";
ALTER TABLE "room_photos" DROP COLUMN "tenant_id";
ALTER TABLE "match_results" DROP COLUMN "tenant_id";
ALTER TABLE "intro_requests" DROP COLUMN "tenant_id";