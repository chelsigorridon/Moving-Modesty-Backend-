CREATE TABLE "courier_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"collection" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_delivery_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "courier_plan" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "private_note" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "booking_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "order_delivery_history" ADD CONSTRAINT "order_delivery_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_delivery_history_revision_idx" ON "order_delivery_history" USING btree ("order_id","revision");