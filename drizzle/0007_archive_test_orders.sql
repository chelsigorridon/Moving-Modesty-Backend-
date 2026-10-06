ALTER TABLE "orders" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "archive_reason" text;