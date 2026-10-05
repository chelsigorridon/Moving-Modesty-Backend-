ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_snapshot" jsonb;
--> statement-breakpoint
-- Align existing nullable schema placeholders without enabling stock control.
-- Drizzle includes these columns even when an insert supplies DEFAULT.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "inventory_issue" text;
--> statement-breakpoint
-- Preserve the currently recorded identity on historical orders before any
-- future checkout updates a shared customer profile.
UPDATE "orders" AS o SET "customer_snapshot" = jsonb_build_object(
  'firstName', c.first_name, 'lastName', c.last_name,
  'email', c.email, 'phone', COALESCE(c.phone, '')
) FROM customers AS c WHERE o.customer_id = c.id AND o.customer_snapshot IS NULL;
