-- ============================================================================
-- 20260907120000_maintenance_tickets
-- Phase 17: maintenance tickets + update thread (11 §11.5, 04 §4.6,
-- 05 §5.7).
--
-- New tables (2):
--   maintenance_tickets — one row per maintenance issue raised against
--                         a room by a tenant. Lifecycle = state machine
--                         (OPEN → ACKNOWLEDGED → IN_PROGRESS → RESOLVED
--                         → CLOSED, plus CANCELLED and DISPUTED branches).
--                         Carries SLA target + lazy breach flag, lifecycle
--                         timestamps (resolved_at, closed_at), and the
--                         post-resolution rating (1..5).
--   maintenance_updates — append-only comment thread on a ticket. Each
--                         row can also snapshot a post-call status to
--                         merge "comment + transition" calls into one
--                         timeline entry.
--
-- Enums (3): MaintenanceCategory, MaintenancePriority, MaintenanceStatus.
--
-- Critical constraints (hand-edited):
--   maintenance_tickets_rating_chk    — CHECK (rating BETWEEN 1 AND 5).
--                                       Enforced at the DB so the rating
--                                       column can't be poisoned by a
--                                       buggy migration.
--   tickets_sla_watch_idx             — PARTIAL INDEX on
--                                       (status, sla_target_at) WHERE
--                                       status NOT IN
--                                       ('CLOSED','CANCELLED','RESOLVED').
--                                       Keeps the breach-watch scan small
--                                       even as historical tickets pile up.
--
-- Foreign keys (6):
--   ticket → room            Restrict  (audit trail preserved)
--   ticket → lease           Restrict  (snapshot — see schema.prisma)
--   ticket → raisedBy user   Restrict
--   ticket → resolvedBy user Restrict, NULL  (one-to-zero-or-one)
--   ticket → closedBy user   Restrict, NULL  (one-to-zero-or-one)
--   update → ticket          Cascade   (update thread dies with ticket)
--   update → author user     Restrict
--
-- Lease.post-lease grace (spec 11 §11.5.5): tenants may raise a ticket
-- up to 7 days after lease.endDate. That grace window is enforced at
-- the service layer, not in the DB — the schema permits any historical
-- ticket.
-- ============================================================================

-- ── Enum types ──────────────────────────────────────────────────────────
CREATE TYPE "MaintenanceCategory" AS ENUM (
    'PLUMBING',
    'ELECTRICAL',
    'APPLIANCE',
    'HVAC',
    'STRUCTURAL',
    'PEST',
    'OTHER'
);

CREATE TYPE "MaintenancePriority" AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'URGENT'
);

CREATE TYPE "MaintenanceStatus" AS ENUM (
    'OPEN',
    'ACKNOWLEDGED',
    'IN_PROGRESS',
    'RESOLVED',
    'CLOSED',
    'CANCELLED',
    'DISPUTED'
);

-- ── Tables ──────────────────────────────────────────────────────────────

CREATE TABLE "maintenance_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "lease_id" UUID NOT NULL,
    "raised_by_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "MaintenanceCategory" NOT NULL,
    "priority" "MaintenancePriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "sla_target_at" TIMESTAMPTZ(6) NOT NULL,
    "sla_breached_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_user_id" UUID,
    "rating" INTEGER,
    "rating_comment" TEXT,
    "rating_submitted_at" TIMESTAMPTZ(6),
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "maintenance_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "maintenance_tickets_rating_chk" CHECK ("rating" IS NULL OR ("rating" BETWEEN 1 AND 5))
);

CREATE TABLE "maintenance_updates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "status_after" "MaintenanceStatus",
    "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "maintenance_updates_pkey" PRIMARY KEY ("id")
);

-- ── Indexes (Prisma-tracked) ────────────────────────────────────────────

CREATE INDEX "tickets_room_status_idx"
    ON "maintenance_tickets" ("room_id", "status");

CREATE INDEX "tickets_raiser_idx"
    ON "maintenance_tickets" ("raised_by_user_id", "created_at" DESC);

CREATE INDEX "maintenance_updates_ticket_idx"
    ON "maintenance_updates" ("ticket_id", "created_at" ASC);

-- ── Indexes (hand-edited) ──────────────────────────────────────────────

-- Partial SLA-watch index. Trims the index to only tickets that can
-- still breach: anything CLOSED, CANCELLED, or RESOLVED is past its
-- breach window, so indexing them wastes space and slows the scan.
CREATE INDEX "tickets_sla_watch_idx"
    ON "maintenance_tickets" ("status", "sla_target_at")
    WHERE "status" NOT IN ('CLOSED', 'CANCELLED', 'RESOLVED');

-- ── Foreign keys ────────────────────────────────────────────────────────

-- ticket → room
ALTER TABLE "maintenance_tickets"
    ADD CONSTRAINT "maintenance_tickets_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "rooms"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ticket → lease (snapshot)
ALTER TABLE "maintenance_tickets"
    ADD CONSTRAINT "maintenance_tickets_lease_id_fkey"
    FOREIGN KEY ("lease_id") REFERENCES "leases"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ticket → raisedBy user
ALTER TABLE "maintenance_tickets"
    ADD CONSTRAINT "maintenance_tickets_raised_by_user_id_fkey"
    FOREIGN KEY ("raised_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ticket → resolvedBy user (nullable, one-to-zero-or-one)
ALTER TABLE "maintenance_tickets"
    ADD CONSTRAINT "maintenance_tickets_resolved_by_user_id_fkey"
    FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ticket → closedBy user (nullable, one-to-zero-or-one)
ALTER TABLE "maintenance_tickets"
    ADD CONSTRAINT "maintenance_tickets_closed_by_user_id_fkey"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- update → ticket (cascade — comment thread dies with the ticket)
ALTER TABLE "maintenance_updates"
    ADD CONSTRAINT "maintenance_updates_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "maintenance_tickets"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

-- update → author user
ALTER TABLE "maintenance_updates"
    ADD CONSTRAINT "maintenance_updates_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
