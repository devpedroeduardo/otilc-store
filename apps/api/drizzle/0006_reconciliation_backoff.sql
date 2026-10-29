ALTER TYPE "public"."payment_alert" ADD VALUE 'RECONCILIATION_STOPPED';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "check_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_check_failures_non_negative" CHECK ("payments"."check_failures" >= 0);