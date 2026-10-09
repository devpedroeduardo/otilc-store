DROP INDEX "variants_product_size_color_idx";--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_size_color_idx" UNIQUE NULLS NOT DISTINCT("product_id","size","color");