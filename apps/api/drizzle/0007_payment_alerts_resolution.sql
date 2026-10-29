ALTER TABLE "payment_alerts" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_alerts" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "payment_alerts" ADD CONSTRAINT "payment_alerts_resolved_by_admin_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_alerts_open_created_idx" ON "payment_alerts" USING btree ("created_at") WHERE "payment_alerts"."resolved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_alerts" ADD CONSTRAINT "payment_alerts_resolved_by_needs_resolved_at" CHECK ("payment_alerts"."resolved_by" IS NULL OR "payment_alerts"."resolved_at" IS NOT NULL);