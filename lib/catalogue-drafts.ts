import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { catalogueDrafts } from "./db/schema";
import { catalogueSaveSchema, type CatalogueSaveInput } from "./catalogue-input";

export class CatalogueConflictError extends Error {}

export function catalogueTrialEnabled() {
  // Rollout is opt-in. Nothing in this trial changes the live checkout catalogue.
  return process.env.PRODUCT_CATALOGUE_TRIAL_ENABLED === "true" && process.env.VERCEL_ENV !== "production"
    && (process.env.NODE_ENV !== "production" || process.env.VERCEL_ENV === "preview");
}

export async function listCatalogueDrafts(database = db) {
  if (!database) throw new Error("Database is not configured.");
  return database.select().from(catalogueDrafts).orderBy(catalogueDrafts.createdAt);
}

export async function saveCatalogueDraft(input: CatalogueSaveInput, database = db) {
  if (!database) throw new Error("Database is not configured.");
  const { id, document, expectedRevision } = catalogueSaveSchema.parse(input);
  return database.transaction(async transaction => {
    // Lock creation as well as update, so two first saves cannot race a slug.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-catalogue-drafts', 0))`);
    const [existing] = id ? await transaction.select().from(catalogueDrafts).where(eq(catalogueDrafts.id, id)).for("update").limit(1) : [];
    if (id && !existing) throw new CatalogueConflictError("This draft no longer exists. Refresh the product list.");
    if ((existing?.revision ?? 0) !== expectedRevision) throw new CatalogueConflictError("This product changed in another window. Refresh before saving so those changes are not overwritten.");
    if (existing && existing.slug !== document.slug) throw new CatalogueConflictError("The saved page address cannot be changed during this trial.");
    const [slugOwner] = await transaction.select({ id: catalogueDrafts.id }).from(catalogueDrafts).where(eq(catalogueDrafts.slug, document.slug)).limit(1);
    if (slugOwner && slugOwner.id !== id) throw new CatalogueConflictError("Another product already uses this page address.");
    const otherDrafts = await transaction.select({ id: catalogueDrafts.id, document: catalogueDrafts.document }).from(catalogueDrafts);
    const idsInOtherProducts = new Set(otherDrafts.filter(draft => draft.id !== id).flatMap(draft =>
      draft.document.colours.flatMap(colour => [colour.id, ...colour.variants.map(entry => entry.id)])));
    if (document.colours.some(colour => [colour.id, ...colour.variants.map(entry => entry.id)].some(value => idsInOtherProducts.has(value)))) {
      throw new CatalogueConflictError("Colour and size identifiers cannot be reused across products.");
    }
    const values = { slug: document.slug, document, revision: expectedRevision + 1, updatedAt: new Date() };
    const [saved] = existing
      ? await transaction.update(catalogueDrafts).set(values).where(eq(catalogueDrafts.id, existing.id)).returning()
      : await transaction.insert(catalogueDrafts).values(values).returning();
    return saved;
  });
}
