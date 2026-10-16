CREATE TABLE "bobgo_order_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"channel_ref" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"remote_order_id" text,
	"delivery_revision" integer DEFAULT 0 NOT NULL,
	"request_snapshot" jsonb,
	"submitted_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "shipping_weight_grams" integer;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "courier_status" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "courier_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bobgo_order_sync" ADD CONSTRAINT "bobgo_order_sync_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bobgo_order_sync_order_channel_idx" ON "bobgo_order_sync" USING btree ("order_id","environment","channel_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "bobgo_order_sync_remote_channel_idx" ON "bobgo_order_sync" USING btree ("remote_order_id","environment","channel_ref");