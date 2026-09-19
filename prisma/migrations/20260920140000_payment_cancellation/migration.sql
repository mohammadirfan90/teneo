-- Stripe cancellation support (assignment brief: "payment creation,
-- success/cancellation callbacks, and status tracking").
--
-- CANCELED is deliberately separate from FAILED: a cancelled intent was
-- never charged and declined, so the rent invoice stays DUE and payable.
-- PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new label is not used in that same transaction; the columns
-- below only store it later, at runtime.
ALTER TYPE "PaymentStatus" ADD VALUE 'CANCELED' AFTER 'FAILED';

ALTER TABLE "payments"
  ADD COLUMN "canceled_at" TIMESTAMPTZ(6),
  ADD COLUMN "cancellation_reason" TEXT;
