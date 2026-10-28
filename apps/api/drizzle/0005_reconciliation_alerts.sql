ALTER TYPE "public"."payment_alert" ADD VALUE 'PAYMENT_REVERSED';--> statement-breakpoint
CREATE TABLE "payment_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"alert" "payment_alert" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_alerts_payment_alert_unique" UNIQUE("payment_id","alert")
);
--> statement-breakpoint
ALTER TABLE "payment_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_alerts" ADD CONSTRAINT "payment_alerts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_status_created_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
-- Acrescentado à mão (spec-015): o histórico começa com os alertas que já existiam.
INSERT INTO "payment_alerts" ("payment_id", "alert", "created_at")
SELECT "id", "alert", "updated_at" FROM "payments" WHERE "alert" IS NOT NULL
ON CONFLICT DO NOTHING;
