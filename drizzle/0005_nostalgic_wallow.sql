CREATE TABLE "diagnostic_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"incident_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"resend_email_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"reference" uuid NOT NULL,
	"order_id" uuid,
	"source" text NOT NULL,
	"operation" text NOT NULL,
	"code" text NOT NULL,
	"summary" text NOT NULL,
	"severity" text NOT NULL,
	"environment" text NOT NULL,
	"http_status" integer,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN "delivery_event" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN "delivery_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "stock_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "error_alerts" ADD CONSTRAINT "error_alerts_incident_id_system_errors_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."system_errors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_errors" ADD CONSTRAINT "system_errors_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "error_alerts_dedupe_idx" ON "error_alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_reservations_order_variant_idx" ON "stock_reservations" USING btree ("order_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "system_errors_fingerprint_idx" ON "system_errors" USING btree ("fingerprint");