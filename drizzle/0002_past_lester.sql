CREATE TYPE "public"."shipment_status" AS ENUM('not_ready', 'ready_to_book', 'booking', 'booked', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'bobgo' NOT NULL,
	"status" "shipment_status" DEFAULT 'not_ready' NOT NULL,
	"sender_location_name" text DEFAULT 'Constantia Emporium' NOT NULL,
	"pickup_point_location_id" text,
	"weight_grams" integer,
	"length_cm" numeric(8, 2),
	"width_cm" numeric(8, 2),
	"height_cm" numeric(8, 2),
	"provider_shipment_id" text,
	"service_level_code" text,
	"waybill_reference" text,
	"tracking_number" text,
	"tracking_url" text,
	"last_error" text,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");