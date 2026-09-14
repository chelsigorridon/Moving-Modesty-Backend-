ALTER TYPE "public"."order_status" ADD VALUE 'collected' BEFORE 'delivered';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_token_idx" ON "orders" USING btree ("checkout_token");