CREATE TYPE "public"."payment_alert" AS ENUM('PAID_AFTER_EXPIRY', 'AMOUNT_MISMATCH', 'DUPLICATE_PAYMENT');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED');--> statement-breakpoint
CREATE TABLE "payment_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar(128) NOT NULL,
	"provider_payment_id" varchar(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_notifications_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "payment_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" varchar(20) DEFAULT 'mercadopago' NOT NULL,
	"provider_payment_id" varchar(64) NOT NULL,
	"status" "payment_status" NOT NULL,
	"amount_cents" integer NOT NULL,
	"qr_code" text,
	"qr_code_base64" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"alert" "payment_alert",
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_payment_id_unique" UNIQUE("provider_payment_id"),
	CONSTRAINT "payments_provider_valid" CHECK ("payments"."provider" = 'mercadopago'),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_pending_per_order_idx" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'PENDING';