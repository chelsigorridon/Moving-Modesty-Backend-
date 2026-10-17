ALTER TABLE "bobgo_order_sync" ADD COLUMN "waybill_link_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "bobgo_order_sync" ADD COLUMN "waybill_link_error_code" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_provider_remote_idx" ON "shipments" USING btree ("provider", "provider_shipment_id");
