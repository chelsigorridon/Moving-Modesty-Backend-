CREATE TABLE "catalogue_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"document" jsonb NOT NULL,
	"published_document" jsonb,
	"metadata" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_revision" integer DEFAULT 0 NOT NULL,
	"publication_state" text DEFAULT 'idle' NOT NULL,
	"publication_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalogue_products" ADD CONSTRAINT "catalogue_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_products_slug_idx" ON "catalogue_products" USING btree ("slug");