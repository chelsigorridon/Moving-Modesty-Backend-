import { z } from "zod";

export const productVariantInputSchema = z.object({
  id: z.string().uuid().optional(),
  size: z.string().trim().min(1).max(80),
  colour: z.string().trim().min(1).max(120),
  sku: z.string().trim().min(2).max(100),
  price: z.number().finite().nonnegative(),
  stock: z.number().int().nonnegative(),
  lowStockThreshold: z.number().int().nonnegative(),
});

export const productInputSchema = z.object({
  name: z.string().trim().min(2).max(200),
  category: z.string().trim().min(2).max(120),
  description: z.string().trim().max(5000).default(""),
  image: z.union([z.string().url(), z.literal("")]).default(""),
  status: z.enum(["Active", "Draft"]),
  variants: z.array(productVariantInputSchema).min(1).max(100),
}).superRefine((product, context) => {
  const seen = new Set<string>();
  product.variants.forEach((variant, index) => {
    const sku = variant.sku.toLowerCase();
    if (seen.has(sku)) {
      context.addIssue({
        code: "custom",
        message: "Each variant needs a unique SKU.",
        path: ["variants", index, "sku"],
      });
    }
    seen.add(sku);
  });
});

export type ProductInput = z.infer<typeof productInputSchema>;
