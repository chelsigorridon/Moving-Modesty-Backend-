import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { requireDatabase } from "./db";
import { catalogueProducts, products, productVariants, inventoryMovements, adminUsers } from "./db/schema";
import type { CatalogueCmsMapping } from "./db/schema";
import { cataloguePublicationIssues, catalogueVariantSku, type CatalogueSaveInput } from "./catalogue-input";
import { CatalogueConflictError } from "./catalogue-drafts";
import { importCmsCatalogue, publishCmsCatalogue, CataloguePublishPreflightError } from "./framer-catalogue-live";

export function liveCatalogueEnabled() { return process.env.PRODUCT_MANAGEMENT_ENABLED === "true"; }
export type CatalogueDatabase = ReturnType<typeof requireDatabase>;
export type CatalogueTransaction = Parameters<Parameters<CatalogueDatabase["transaction"]>[0]>[0];
export function inventoryVersion(rows: Array<{ id: string; stockOnHand: number; stockVerified: boolean; updatedAt: Date }>) {
  return createHash("sha256").update(JSON.stringify(rows.map(row => [row.id, row.stockOnHand, row.stockVerified, row.updatedAt.toISOString()]).sort())).digest("hex");
}

export async function listLiveCatalogue(database = requireDatabase()) {
  const records = await database.select().from(catalogueProducts).orderBy(catalogueProducts.createdAt);
  return Promise.all(records.map(async row => {
    const stock = await database.select().from(productVariants).where(eq(productVariants.productId, row.productId));
    const document = structuredClone(row.document);
    // Never replace an intentional draft edit with a live stock count.
    if (row.revision === row.publishedRevision) for (const colour of document.colours) for (const variant of colour.variants) {
      const actual = stock.find(entry => entry.id === variant.id);
      if (actual) { variant.stock = actual.stockOnHand; variant.stockVerified = actual.stockVerified; }
    }
    return { id: row.id, revision: row.revision, publishedRevision: row.publishedRevision, publicationState: row.publicationState,
      publicationError: row.publicationError, stockVersion: row.revision === row.publishedRevision ? inventoryVersion(stock) : row.metadata.stockVersion,
      document, pageUrl: `${process.env.STORE_URL || "https://holistic-brand-492217.framer.app"}${["amina", "hawa"].includes(row.slug) ? `/${row.slug}` : `/collection/${row.slug}`}` };
  }));
}

export async function initializeLiveCatalogue(database = requireDatabase()) {
  if ((await database.select({ id: catalogueProducts.id }).from(catalogueProducts).limit(1)).length) return;
  const currentProducts = await database.select().from(products);
  const currentVariants = await database.select().from(productVariants);
  const imported = await importCmsCatalogue(currentProducts, currentVariants);
  await database.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-catalogue-management', 0))`);
    if ((await tx.select({ id: catalogueProducts.id }).from(catalogueProducts).limit(1)).length) return;
    for (const item of imported) await tx.insert(catalogueProducts).values({ ...item, publishedDocument: item.document,
      publishedRevision: 1, publishedAt: new Date() });
  });
}

export async function saveLiveCatalogue(input: CatalogueSaveInput & { stockVersion?: string }, database = requireDatabase()) {
  return database.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-catalogue-management', 0))`);
    const all = await tx.select().from(catalogueProducts).for("update");
    const row = input.id ? all.find(item => item.id === input.id) : undefined;
    if (input.id && !row) throw new CatalogueConflictError("Product not found. Reload Products.");
    if ((row?.revision || 0) !== input.expectedRevision) throw new CatalogueConflictError("This product changed in another window. Reload before saving.");
    if (row && row.publicationState !== "idle") throw new CatalogueConflictError("Publishing needs to finish or be checked before editing this product.");
    if (row && input.document.slug !== row.slug) throw new CatalogueConflictError("The published page address cannot change.");
    if (all.some(item => item.id !== row?.id && item.slug === input.document.slug)) throw new CatalogueConflictError("A product already uses this page address.");
    const ids = new Set(input.document.colours.flatMap(c => [c.id, ...c.variants.map(v => v.id)]));
    if (all.some(item => item.id !== row?.id && item.document.colours.some(c => ids.has(c.id) || c.variants.some(v => ids.has(v.id))))) throw new CatalogueConflictError("A colour or size belongs to another product.");
    const stock = row ? await tx.select().from(productVariants).where(eq(productVariants.productId, row.productId)).for("update") : [];
    const incomingIds = input.document.colours.flatMap(colour => colour.variants.map(variant => variant.id));
    const owners = await tx.select({ id: productVariants.id, productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.id, incomingIds));
    if (owners.some(owner => owner.productId !== row?.productId)) throw new CatalogueConflictError("A size belongs to another product.");
    if (row && input.stockVersion !== inventoryVersion(stock)) throw new CatalogueConflictError("Stock changed while you were editing. Reload to see the current quantities.");
    const metadata: CatalogueCmsMapping = structuredClone(row?.metadata || { colours: {}, variantSkus: {} });
    metadata.stockVersion = inventoryVersion(stock);
    for (const colour of input.document.colours) {
      metadata.colours[colour.id] ||= { slug: `${input.document.slug}-${colour.id.slice(0, 8)}`, baseSku: `MM-${colour.id.replaceAll("-", "").toUpperCase()}` };
      for (const variant of colour.variants) metadata.variantSkus[variant.id] ||= catalogueVariantSku(variant.id);
    }
    let productId = row?.productId;
    if (!productId) {
      const [created] = await tx.insert(products).values({ name: input.document.name, slug: `catalogue-${input.document.slug}`, category: input.document.category, status: "draft" }).returning();
      productId = created.id;
    }
    const document = structuredClone(input.document);
    if (!row) document.homepageOrder = Math.max(-1, ...all.map(item => item.document.homepageOrder)) + 1;
    const values = { document, metadata, revision: input.expectedRevision + 1, updatedAt: new Date() };
    const [saved] = row ? await tx.update(catalogueProducts).set(values).where(eq(catalogueProducts.id, row.id)).returning()
      : await tx.insert(catalogueProducts).values({ id: randomUUID(), productId, slug: input.document.slug, ...values }).returning();
    return (await listLiveCatalogue(tx as unknown as CatalogueDatabase)).find(item => item.id === saved.id)!;
  });
}

export async function publishLiveCatalogue(id: string, expectedRevision: number, actor: string, database = requireDatabase()) {
  const row = await database.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-catalogue-management', 0))`);
    const all = await tx.select().from(catalogueProducts).for("update");
    const row = all.find(item => item.id === id);
    if (!row || row.revision !== expectedRevision) throw new CatalogueConflictError("Reload this product before publishing.");
    if (all.some(item => item.publicationState === "publishing")) throw new CatalogueConflictError("Another publish is in progress. Wait before trying again.");
    if (row.publishedRevision === row.revision && row.publicationState === "idle") return row;
    const issues = cataloguePublicationIssues(row.document);
    if (issues.length) throw new CatalogueConflictError(issues[0]);
    const stock = await tx.select().from(productVariants).where(eq(productVariants.productId, row.productId)).for("update");
    if (row.metadata.stockVersion !== inventoryVersion(stock)) throw new CatalogueConflictError("Stock changed since this draft was saved. Reload and save it again.");
    await tx.update(catalogueProducts).set({ publicationState: "publishing", publicationError: null, updatedAt: new Date() }).where(eq(catalogueProducts.id, id));
    return row;
  });
  if (row.publishedRevision === row.revision && row.publicationState === "idle") return (await listLiveCatalogue(database)).find(item => item.id === id)!;
  try {
    const familyOrder = (await database.select().from(catalogueProducts)).sort((a, b) => a.document.homepageOrder - b.document.homepageOrder).map(item => item.slug);
    const metadata = await publishCmsCatalogue(row.document, row.metadata, familyOrder);
    await database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-catalogue-management', 0))`);
      const [current] = await tx.select().from(catalogueProducts).where(eq(catalogueProducts.id, id)).for("update");
      if (current.revision !== row.revision) throw new CatalogueConflictError("Publishing changed unexpectedly. Ask support to reconcile this product.");
      const actual = await tx.select().from(productVariants).where(eq(productVariants.productId, row.productId)).for("update");
      if (row.metadata.stockVersion !== inventoryVersion(actual)) throw new CatalogueConflictError("Inventory changed during publication. Checkout remains paused for this product until reconciled.");
      const [admin] = await tx.select().from(adminUsers).where(eq(adminUsers.email, actor)).limit(1);
      const retained = new Set<string>();
      for (const colour of row.document.colours) for (const variant of colour.variants) {
        retained.add(variant.id);
        const previous = actual.find(item => item.id === variant.id);
        if (previous && previous.productId !== row.productId) throw new CatalogueConflictError("Variant ownership mismatch.");
        const stockVerified = variant.stockVerified ?? previous?.stockVerified ?? true;
        await tx.insert(productVariants).values({ id: variant.id, productId: row.productId, sku: previous?.sku || metadata.variantSkus[variant.id],
          size: variant.size, colour: colour.name, price: variant.price.toFixed(2), stockOnHand: variant.stock, stockVerified, active: colour.available && variant.available })
          .onConflictDoUpdate({ target: productVariants.id, set: { size: variant.size, colour: colour.name, price: variant.price.toFixed(2),
            stockOnHand: variant.stock, stockVerified, active: colour.available && variant.available, updatedAt: new Date() } });
        const difference = variant.stock - (previous?.stockOnHand || 0);
        if (difference) await tx.insert(inventoryMovements).values({ variantId: variant.id, type: previous ? "correction" : "stock_received", quantity: difference,
          adminUserId: admin?.id, note: `Product editor stock update by ${actor}` });
      }
      for (const variant of actual) if (!retained.has(variant.id)) await tx.update(productVariants).set({ active: false, updatedAt: new Date() }).where(eq(productVariants.id, variant.id));
      await tx.update(products).set({ name: row.document.name, description: row.document.description, category: row.document.category,
        primaryImageUrl: row.document.homepageImage.url, status: "active", updatedAt: new Date() }).where(eq(products.id, row.productId));
      await tx.update(catalogueProducts).set({ metadata, publishedDocument: row.document, publishedRevision: row.revision, publicationState: "idle",
        publishedAt: new Date(), updatedAt: new Date(), publicationError: null }).where(eq(catalogueProducts.id, id));
    });
    return (await listLiveCatalogue(database)).find(item => item.id === id)!;
  } catch (error) {
    // A timeout may have published CMS content. Fail closed; never claim success or silently release checkout.
    await database.update(catalogueProducts).set({ publicationState: error instanceof CataloguePublishPreflightError ? "idle" : "needs_review", publicationError: error instanceof CataloguePublishPreflightError ? error.message : "Publication could not be verified. Ask support to check CMS and inventory before retrying.", updatedAt: new Date() }).where(eq(catalogueProducts.id, id));
    throw error;
  }
}
