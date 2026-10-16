import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireDatabase } from "./db";
import { productVariants, products, shippingWeightHistory } from "./db/schema";

const grams = z.number().int().min(1).max(30000).nullable();
export const shippingWeightInput = z.object({ confirmed: z.literal(true), changes: z.array(z.object({ id: z.string().uuid(), expectedGrams: grams, grams })).max(100) })
  .refine(value => new Set(value.changes.map(row => row.id)).size === value.changes.length, "Each product size may appear only once.");
export class ShippingWeightConflict extends Error {}
export async function getShippingWeights() {
  return requireDatabase().select({ id: productVariants.id, product: products.name, colour: productVariants.colour,
    size: productVariants.size, grams: productVariants.shippingWeightGrams }).from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId)).orderBy(products.name, productVariants.colour, productVariants.size);
}
export async function saveShippingWeights(value: unknown, changedBy: string) {
  const input = shippingWeightInput.parse(value);
  return requireDatabase().transaction(async tx => {
    for (const change of [...input.changes].sort((a, b) => a.id.localeCompare(b.id))) {
      const [row] = await tx.select().from(productVariants).where(eq(productVariants.id, change.id)).for("update");
      if (!row || row.shippingWeightGrams !== change.expectedGrams) throw new ShippingWeightConflict("Weights changed elsewhere. Reload them before saving.");
      if (row.shippingWeightGrams === change.grams) continue;
      await tx.update(productVariants).set({ shippingWeightGrams: change.grams, updatedAt: new Date() }).where(eq(productVariants.id, row.id));
      await tx.insert(shippingWeightHistory).values({ variantId: row.id, previousGrams: row.shippingWeightGrams, grams: change.grams, changedBy });
    }
    return { saved: true, weights: await tx.select({ id: productVariants.id, product: products.name, colour: productVariants.colour,
      size: productVariants.size, grams: productVariants.shippingWeightGrams }).from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId)).orderBy(products.name, productVariants.colour, productVariants.size) };
  });
}
