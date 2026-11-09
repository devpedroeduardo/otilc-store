CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" varchar(40) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(200),
	"provider_message_id" varchar(100),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_order_kind_unique" UNIQUE("order_id","kind"),
	CONSTRAINT "email_outbox_kind_valid" CHECK ("email_outbox"."kind" IN ('order_confirmation')),
	CONSTRAINT "email_outbox_status_valid" CHECK ("email_outbox"."status" IN ('pending', 'sent', 'failed')),
	CONSTRAINT "email_outbox_attempts_non_negative" CHECK ("email_outbox"."attempts" >= 0),
	CONSTRAINT "email_outbox_sent_has_sent_at" CHECK ("email_outbox"."status" <> 'sent' OR "email_outbox"."sent_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_pending_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."status" = 'pending';