import "server-only";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { requireDatabase } from "./db";
import { catalogueProducts, productVariants, stockReservations, inventoryMovements, orderItems, orders } from "./db/schema";
import type { CatalogueTransaction } from "./catalogue-live";
import { resolveCheckoutItem, type CheckoutCatalogueItem } from "./checkout-catalogue";

export type LiveCheckoutItem = CheckoutCatalogueItem & { variantId?: string; productId?: string; available: boolean; stock: number | null };
const liveCatalogueEnabled = () => process.env.PRODUCT_MANAGEMENT_ENABLED === "true";
export async function resolveLiveCheckoutItem(sku: string, tx?: CatalogueTransaction, excludeOrderId?: string): Promise<LiveCheckoutItem | null> {
  if (!liveCatalogueEnabled()) { const item = resolveCheckoutItem(sku); return item ? { ...item, available: true, stock: null } : null; }
  const database = tx || requireDatabase();
  const records = await database.select().from(catalogueProducts);
  for (const record of records) {
    const id = Object.keys(record.metadata.variantSkus).find(id => record.metadata.variantSkus[id].toUpperCase() === sku.toUpperCase());
    if (!id || !record.publishedDocument) continue;
    const colour = record.publishedDocument.colours.find(colour => colour.variants.some(variant => variant.id === id));
    const variant = colour?.variants.find(variant => variant.id === id);
    if (!variant || !colour) return null;
    const [actual] = tx ? await tx.select().from(productVariants).where(eq(productVariants.id, id)).for("update") : await database.select().from(productVariants).where(eq(productVariants.id, id));
    if (!actual) return null;
    const [{ held }] = await database.select({ held: sql<number>`coalesce(sum(${stockReservations.quantity}),0)::integer` }).from(stockReservations)
      .where(and(eq(stockReservations.variantId, id), excludeOrderId ? ne(stockReservations.orderId, excludeOrderId) : undefined, isNull(stockReservations.consumedAt), isNull(stockReservations.releasedAt), gt(stockReservations.expiresAt, new Date())));
    const stock = actual.stockVerified ? Math.max(0, actual.stockOnHand - Number(held)) : null;
    return { sku: record.metadata.variantSkus[id], slug: record.metadata.colours[colour.id].slug, name: record.publishedDocument.name,
      colour: colour.name, size: actual.size, price: Number(actual.price), image: colour.photos[0]?.url || "", variantId: id, productId: actual.productId,
      available: record.publicationState === "idle" && actual.active && colour.available && (stock === null || stock > 0), stock };
  }
  // Existing checkout stays operational until the one-time import is complete.
  if (!records.length) { const item = resolveCheckoutItem(sku); return item ? { ...item, available: true, stock: null } : null; }
  return null;
}

export async function storefrontSizes(productIdentity: string) {
  const records = await requireDatabase().select().from(catalogueProducts);
  for (const record of records) {
    // CMS slugs remain stable in Framer's hydrated product lists, including new products.
    // Always resolve them to the same server-owned variant IDs/SKUs as checkout.
    const colourId = Object.keys(record.metadata.colours).find(id => {
      const identity = record.metadata.colours[id];
      return identity.baseSku === productIdentity || identity.slug === productIdentity;
    });
    const colour = record.publishedDocument?.colours.find(colour => colour.id === colourId);
    if (!colour) { if (colourId) return []; continue; }
    return Promise.all(colour.variants.map(variant => resolveLiveCheckoutItem(record.metadata.variantSkus[variant.id])));
  }
  if (records.length && liveCatalogueEnabled()) return [];
  return [...(await import("./checkout-catalogue")).getCheckoutCatalogue().values()].filter(item => item.sku.startsWith(productIdentity + "-") || item.slug === productIdentity).map(item => ({ ...item, available: true, stock: null }));
}

export async function reserveOrderStock(tx: CatalogueTransaction, orderId: string) {
  if (!liveCatalogueEnabled()) return;
  const lines = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(orderItems.sku);
  for (const line of lines) {
    if (!line.variantId) continue;
    const [variant] = await tx.select().from(productVariants).where(eq(productVariants.id, line.variantId)).for("update");
    if (!variant.active) throw new Error(`${line.productName} is no longer available.`);
    if (!variant.stockVerified) continue;
    const [{ held }] = await tx.select({ held: sql<number>`coalesce(sum(${stockReservations.quantity}),0)::integer` }).from(stockReservations)
      .where(and(eq(stockReservations.variantId, variant.id), ne(stockReservations.orderId, orderId), isNull(stockReservations.consumedAt), isNull(stockReservations.releasedAt), gt(stockReservations.expiresAt, new Date())));
    if (variant.stockOnHand - Number(held) < line.quantity) throw new Error(`There is not enough stock of ${line.productName} (${line.variantName}).`);
    await tx.insert(stockReservations).values({ orderId, variantId: variant.id, quantity: line.quantity, expiresAt: new Date(Date.now() + 30 * 60 * 1000) })
      .onConflictDoUpdate({ target: [stockReservations.orderId, stockReservations.variantId], set: { quantity: line.quantity, expiresAt: new Date(Date.now() + 30 * 60 * 1000), releasedAt: null } });
  }
}
export async function deductPaidStock(tx: CatalogueTransaction, orderId: string) {
  if (!liveCatalogueEnabled()) return;
  const lines = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(orderItems.sku);
  const issues: string[] = [];
  for (const line of lines) {
    if (!line.variantId) continue;
    const [variant] = await tx.select().from(productVariants).where(eq(productVariants.id, line.variantId)).for("update");
    if (!variant.stockVerified) continue;
    const movements = await tx.select().from(inventoryMovements).where(and(eq(inventoryMovements.orderId, orderId), eq(inventoryMovements.variantId, variant.id), eq(inventoryMovements.type, "order_allocated")));
    if (movements.length) continue;
    if (variant.stockOnHand < line.quantity) issues.push(`${line.productName} needs a stock check after payment.`);
    await tx.update(productVariants).set({ stockOnHand: Math.max(0, variant.stockOnHand - line.quantity), updatedAt: new Date() }).where(eq(productVariants.id, variant.id));
    await tx.insert(inventoryMovements).values({ variantId: variant.id, orderId, type: "order_allocated", quantity: -line.quantity, note: "Verified PayFast payment" });
    await tx.update(stockReservations).set({ consumedAt: new Date() }).where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.variantId, variant.id)));
  }
  if (issues.length) await tx.update(orders).set({ inventoryIssue: issues.join(" ") }).where(eq(orders.id, orderId));
}
