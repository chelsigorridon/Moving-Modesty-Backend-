import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Collection, type CollectionItem, type FieldDataInput } from "framer-api";
import type { CatalogueDocument } from "./catalogue-input";
import type { CatalogueCmsMapping, products, productVariants } from "./db/schema";
import { getCheckoutCatalogue } from "./checkout-catalogue";
import { CatalogueConflictError } from "./catalogue-drafts";

const projectUrl = "https://framer.com/projects/Moving-Modesty--HSoQpURWMbVB013b2Lkg";
type Client = Awaited<ReturnType<typeof connect>>;
export async function withCatalogueFramer<T>(work: (client: Client, ensureActive: () => void) => Promise<T>): Promise<T> {
  const key = process.env.FRAMER_API_KEY;
  if (!key || key === "[SENSITIVE]") throw new CataloguePublishPreflightError("The private Framer connection is not configured. Your live product has not changed.");
  let client: Client | undefined;
  let expired = false;
  let workStarted = false;
  const connection = connect(process.env.FRAMER_PROJECT_URL || projectUrl, key).then(async value => {
    if (expired) { await value.disconnect(); throw new Error("Framer connection timed out."); }
    client = value;
    const info = await value.getProjectInfo();
    if (info.name !== "Moving Modesty") throw new Error("Unexpected Framer project.");
    if (expired) throw new Error("Framer connection timed out.");
    workStarted = true;
    return work(value, () => { if (expired) throw new Error("Framer operation timed out. No further CMS edits will be started."); });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([connection, new Promise<T>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("Framer has not confirmed the operation. Reload before retrying.")); }, 45000); })]); }
  catch (error) {
    // Connection/readiness failures happen before any CMS write. Preserve the
    // live product and return a useful, allowlisted message, never SDK secrets.
    if (!workStarted) throw new CataloguePublishPreflightError(framerPreflightMessage(error));
    throw error;
  }
  finally { if (timer) clearTimeout(timer); expired = true; if (client) await Promise.race([client.disconnect().catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, 1500))]); }
}
async function collections(client: Client, preferredLayout?: CatalogueCmsMapping["cmsLayout"]) {
  const all = await client.getCollections();
  const colours = all.find(collection => collection.id === "m15OMOfwH" && collection.name === "Products");
  if (!colours) throw new Error("Product CMS setup is incomplete.");
  // The bridge remains compatible with the old setup until the guarded CMS
  // migration explicitly moves each existing product to the unified layout.
  const legacy = all.find(collection => collection.name === "ProductCatalogue");
  const unified = preferredLayout === "products-v1" || !legacy;
  const families = unified ? colours : legacy!;
  const familyFields = await fieldsByName(families);
  const pageInfoField = unified ? requiredField(familyFields, "Is Product Page") : undefined;
  if (unified) {
    familyFields.set("Tagline", requiredField(familyFields, "Catalogue Tagline"));
    for (const name of ["Name", "Description", "Product Details", "Fabric Materials", "Care Instructions", "Delivery Returns", "Benefits", "Fabric Weight", "Dimensions", "Product Page"]) requiredField(familyFields, name);
  }
  return { colours, families, familyFields, pageInfoField, unified };
}
function isPageInformation(item: CollectionItem, field: string | undefined) {
  return !!field && item.fieldData[field]?.type === "boolean" && item.fieldData[field].value === true;
}
function text(item: CollectionItem, field: string) { const value = item.fieldData[field]; return value && "value" in value && typeof value.value === "string" ? value.value : ""; }
function photo(item: CollectionItem, field: string) { const value = item.fieldData[field]; return value?.type === "image" && value.value ? { url: value.value.url, alt: value.value.altText || "" } : { url: "", alt: "" }; }
function fingerprint(items: CollectionItem[]) {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : value;
  return createHash("sha256").update(JSON.stringify(stable(items.map(item => ({ id: item.id, slug: item.slug, draft: item.draft, fieldData: item.fieldData })).sort((a, b) => a.id.localeCompare(b.id))))).digest("hex");
}
async function fieldsByName(collection: Collection) { return new Map((await collection.getFields()).map(field => [field.name, field.id])); }
function requiredField(fields: Map<string, string>, name: string) { const id = fields.get(name); if (!id) throw new Error(`Missing CMS field: ${name}`); return id; }

export async function importCmsCatalogue(existing: Array<typeof products.$inferSelect>, stock: Array<typeof productVariants.$inferSelect>) {
  return withCatalogueFramer(async client => {
    const { colours, families, familyFields, pageInfoField, unified } = await collections(client);
    const allItems = await colours.getItems();
    const items = allItems.filter(item => !item.draft && !isPageInformation(item, pageInfoField));
    const familyItems = unified ? allItems.filter(item => !item.draft && isPageInformation(item, pageInfoField)) : await families.getItems();
    const result = [];
    for (const family of [{ slug: "amina", prefix: "AMINA-", databaseSlug: "amina-tie-back" }, { slug: "hawa", prefix: "HAWA-", databaseSlug: "hawa-tri-instant-scarf" }]) {
      const product = existing.find(item => item.slug === family.databaseSlug);
      const records = items.filter(item => text(item, "gCtlt7Fof").startsWith(family.prefix));
      if (!product || !records.length) throw new Error("Existing product data is incomplete; import stopped without replacing anything.");
      const featured = records.find(item => item.fieldData.EpZSVC1_n?.type === "boolean" && item.fieldData.EpZSVC1_n.value) || records[0];
      const metadata: CatalogueCmsMapping = { colours: {}, variantSkus: {}, cmsLayout: unified ? "products-v1" : "legacy" };
      const familyItem = familyItems.find(item => item.slug === family.slug);
      if (!familyItem) throw new Error("Existing product page information is missing.");
      metadata.familyCmsId = familyItem.id;
      const familyText = (name: string) => text(familyItem, requiredField(familyFields, name));
      const document: CatalogueDocument = { name: text(featured, "hv_BclQc4") || product.name, slug: family.slug,
        description: familyText("Description"), category: product.category, tagline: text(featured, "TGuCVRJQV"),
        productDetails: familyText("Product Details"), fabricMaterials: familyText("Fabric Materials"), benefits: familyText("Benefits"), fabricWeight: familyText("Fabric Weight"), dimensions: familyText("Dimensions"),
        careInstructions: text(featured, "NX_2iSY8r"), deliveryReturns: text(featured, "T6xmlvzLS"),
        homepageImage: photo(featured, "RB5aKrO1p").url ? photo(featured, "RB5aKrO1p") : photo(featured, "pN_SP_2Jp"),
        showOnHomepage: true, homepageOrder: family.slug === "amina" ? 0 : 1,
        colours: records.map(record => {
          const id = randomUUID(), baseSku = text(record, "gCtlt7Fof");
          metadata.colours[id] = { cmsId: record.id, slug: record.slug, baseSku };
          const matching = [...getCheckoutCatalogue().values()].filter(item => item.sku.startsWith(baseSku + "-"));
          const gallery = record.fieldData.PBxsbWQ7E;
          const photos = gallery?.type === "array" ? gallery.value.flatMap(entry => { const image = entry.fieldData.GiixFhwbX; return image?.type === "image" && image.value ? [{ url: image.value.url, alt: image.value.altText || "" }] : []; }) : [];
          const variants = matching.map(legacy => {
            const actual = stock.find(item => item.productId === product.id && item.colour.toLowerCase() === legacy.colour.toLowerCase() && item.size === legacy.size);
            if (!actual) throw new Error("A legacy variant has no inventory record; import stopped.");
            metadata.variantSkus[actual.id] = legacy.sku;
            return { id: actual.id, size: actual.size, price: Number(text(record, "UaUoAYeYW").replace(/[^\d.]/g, "")), stock: actual.stockOnHand,
              stockVerified: actual.stockVerified, available: actual.active };
          });
          if (!variants.length) throw new Error("A colour has no checkout variants; import stopped.");
          return { id, name: text(record, "MT9QIiqB2") || matching[0].colour, available: true, photos: photos.length ? photos : [photo(record, "pN_SP_2Jp")], variants };
        }) };
      metadata.cmsHash = fingerprint([...records, familyItem]);
      result.push({ productId: product.id, slug: family.slug, document, metadata });
    }
    return result;
  });
}

export class CataloguePublishPreflightError extends CatalogueConflictError {}
function framerPreflightMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/view.only|unauthori[sz]ed|forbidden|permission|access.denied/i.test(message)) return "Framer did not allow product publishing with the current connection. Website support needs to check its project permissions. Your live product has not changed.";
  if (/unexpected framer project/i.test(message)) return "The Framer connection points to a different project. Your live product has not changed.";
  if (/timed? out|timeout|has not confirmed/i.test(message)) return "Framer did not respond before product editing began. Your live product has not changed; please try again later.";
  return "Framer could not complete the product publishing checks. Your live product has not changed; please ask website support to check the connection and CMS setup.";
}
export async function publishCmsCatalogue(document: CatalogueDocument, previous: CatalogueCmsMapping, familyOrder: string[] = []) {
  return withCatalogueFramer(async (client, ensureActive) => {
    let mutationStarted = false;
    try {
    const { colours, families, familyFields, pageInfoField, unified } = await collections(client, previous.cmsLayout);
    const currentColours = await colours.getItems();
    const allFamilies = unified ? currentColours.filter(item => isPageInformation(item, pageInfoField)) : await families.getItems();
    const owned = currentColours.filter(item => Object.values(previous.colours).some(colour => colour.cmsId === item.id));
    if (owned.some(item => isPageInformation(item, pageInfoField))) throw new CataloguePublishPreflightError("A colour is linked to page information. Ask support to check the CMS mapping.");
    const existingFamily = allFamilies.find(item => item.id === previous.familyCmsId);
    if (previous.cmsHash && fingerprint([...owned, ...(existingFamily ? [existingFamily] : [])]) !== previous.cmsHash) throw new CataloguePublishPreflightError("These products were edited directly in Framer. Ask support to refresh the CMS import before publishing.");
    // Publishing is site-wide. Do not ship someone else's pending canvas edits.
    const before = await client.agent.publish({ action: "preview" }) as { status?: string; changesCount?: number; errors?: unknown[] };
    if (before.status !== "ready" || before.changesCount || before.errors?.length) throw new CataloguePublishPreflightError("Framer has unpublished changes. Publish or review those in Framer first, then retry this product.");
    const mapping = structuredClone(previous);
    mapping.cmsLayout = unified ? "products-v1" : "legacy";
    const family = allFamilies.find(item => item.id === mapping.familyCmsId || item.slug === document.slug);
    if (unified && currentColours.some(item => item.slug === document.slug && !isPageInformation(item, pageInfoField))) throw new CataloguePublishPreflightError("The product page address is already used by a colour. Choose a different page address.");
    const familyData: FieldDataInput = {};
    for (const [name, value] of [["Name", document.name], ["Description", document.description], ["Tagline", document.tagline || ""],
      ["Product Details", document.productDetails || ""], ["Fabric Materials", document.fabricMaterials || ""], ["Care Instructions", document.careInstructions || ""], ["Delivery Returns", document.deliveryReturns || ""]]) familyData[requiredField(familyFields, name)] = { type: "string", value };
    for (const [name, value] of [["Benefits", document.benefits || ""], ["Fabric Weight", document.fabricWeight || ""], ["Dimensions", document.dimensions || ""]]) familyData[requiredField(familyFields, name)] = { type: "string", value };
    if (unified) {
      familyData[pageInfoField!] = { type: "boolean", value: true };
      familyData[requiredField(familyFields, "Product Page")] = { type: "string", value: document.slug };
      // Page-information rows must never become purchase/homepage colour cards.
      for (const name of ["Featured", "Show In Catalogue", "Has Carousel"]) familyData[requiredField(familyFields, name)] = { type: "boolean", value: false };
    }
    ensureActive();
    mutationStarted = true;
    await families.addItems([{ ...(family ? { id: family.id } : {}), slug: document.slug, draft: false, fieldData: familyData }]);
    mapping.familyCmsId = (await families.getItems()).find(item => item.slug === document.slug)!.id;
    const colourFields = await fieldsByName(colours);
    const pageField = requiredField(colourFields, "Product Page");
    for (const [index, colour] of document.colours.entries()) {
      const identity = mapping.colours[colour.id];
      const current = currentColours.find(item => item.id === identity.cmsId || item.slug === identity.slug);
      const price = Math.min(...colour.variants.map(variant => variant.price));
      const photo = colour.photos[0] || { url: "", alt: "" };
      const data: FieldDataInput = {
        lNaBLbLNF: { type: "string", value: `${document.name} - ${colour.name}` }, MT9QIiqB2: { type: "string", value: colour.name },
        UaUoAYeYW: { type: "string", value: `R ${price.toFixed(2)}` }, gCtlt7Fof: { type: "string", value: identity.baseSku },
        ddo9343_D: { type: "string", value: document.description }, nqhhsyc5P: { type: "string", value: document.category },
        JaEVkAyC6: { type: "string", value: colour.variants.map(variant => variant.size).join(" / ") },
        vjUSu8rT2: { type: "string", value: colour.available ? "Available" : "Unavailable" },
        u1l_pIaRe: { type: "string", value: "Managed in admin portal" }, [pageField]: { type: "string", value: document.slug },
        NX_2iSY8r: { type: "string", value: document.careInstructions || "" }, T6xmlvzLS: { type: "string", value: document.deliveryReturns || "" },
        gjnCnMcDz: { type: "boolean", value: true }, hbuc7C5Db: { type: "boolean", value: colour.photos.length > 1 },
        pN_SP_2Jp: { type: "image", value: photo.url || null },
        PBxsbWQ7E: { type: "array", value: colour.photos.map(image => ({ fieldData: { GiixFhwbX: { type: "image", value: image.url } } })) },
        EpZSVC1_n: { type: "boolean", value: index === 0 && document.showOnHomepage },
        hv_BclQc4: { type: "string", value: document.name }, TGuCVRJQV: { type: "string", value: document.tagline || "" },
        RB5aKrO1p: { type: "image", value: document.homepageImage.url || null },
        hgqgdsqCt: { type: "link", value: ["amina", "hawa"].includes(document.slug) ? `/${document.slug}` : `/collection/${document.slug}` },
      };
      if (unified) data[pageInfoField!] = { type: "boolean", value: false };
      ensureActive();
      await colours.addItems([{ ...(current ? { id: current.id } : {}), slug: identity.slug, draft: false, fieldData: data }]);
      identity.cmsId = (await colours.getItems()).find(item => item.slug === identity.slug)!.id;
    }
    const retained = new Set(document.colours.map(colour => mapping.colours[colour.id].cmsId));
    // Removed colours remain recoverable drafts, never physical deletions.
    for (const item of owned) if (!retained.has(item.id)) { ensureActive(); await item.setAttributes({ draft: true }); }
    const ordered = await colours.getItems();
    const rank = (item: CollectionItem) => {
      if (isPageInformation(item, pageInfoField)) return familyOrder.length + 1;
      const index = familyOrder.indexOf(text(item, pageField)); return index < 0 ? familyOrder.length : index;
    };
    ensureActive();
    await colours.setItemOrder(ordered.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(entry => entry.item.id));
    const preview = await client.agent.publish({ action: "preview" }) as { status?: string; confirmationHash?: string; errors?: unknown[]; warnings?: unknown[] };
    if (preview.status !== "ready" || !preview.confirmationHash || preview.errors?.length || preview.warnings?.length) throw new Error("Framer needs a publish review.");
    ensureActive();
    const published = await client.agent.publish({ action: "confirm_publish", confirmationHash: preview.confirmationHash }) as { status?: string };
    if (published.status !== "published") throw new Error("Framer did not confirm publication.");
    const after = await colours.getItems();
    const updated = after.filter(item => Object.values(mapping.colours).some(colour => colour.cmsId === item.id));
    const updatedFamily = (await families.getItems()).find(item => item.id === mapping.familyCmsId)!;
    mapping.cmsHash = fingerprint([...updated, updatedFamily]);
    return mapping;
    } catch (error) {
      if (!mutationStarted && !(error instanceof CataloguePublishPreflightError)) throw new CataloguePublishPreflightError(framerPreflightMessage(error));
      // Once a CMS write was attempted, keep the existing fail-closed rule:
      // only reconciliation can establish whether that write took effect.
      throw error;
    }
  });
}

// Read-only reconciliation for the explicit two-collection migration. It never
// publishes, changes stock, rewrites a product draft or contacts a payment API.
export async function readConsolidatedCmsMapping(document: CatalogueDocument, previous: CatalogueCmsMapping) {
  return withCatalogueFramer(async client => {
    const { colours, pageInfoField, familyFields } = await collections(client, "products-v1");
    const items = await colours.getItems();
    const family = items.find(item => item.slug === document.slug && isPageInformation(item, pageInfoField));
    if (!family || family.draft) throw new Error("The migrated product-page record is missing or still a draft.");
    for (const [name, expected] of [["Name", document.name], ["Description", document.description], ["Tagline", document.tagline || ""],
      ["Product Details", document.productDetails || ""], ["Fabric Materials", document.fabricMaterials || ""], ["Care Instructions", document.careInstructions || ""],
      ["Delivery Returns", document.deliveryReturns || ""], ["Benefits", document.benefits || ""], ["Fabric Weight", document.fabricWeight || ""], ["Dimensions", document.dimensions || ""]]) {
      if (text(family, requiredField(familyFields, name)) !== expected) throw new Error(`Migrated ${name} does not match the published product. Reconciliation stopped.`);
    }
    const owned = document.colours.map(colour => {
      const identity = previous.colours[colour.id];
      const item = identity && items.find(item => item.id === identity.cmsId && item.slug === identity.slug);
      if (!item || item.draft || isPageInformation(item, pageInfoField)) throw new Error("An existing colour record changed or is missing; reconciliation stopped.");
      return item;
    });
    return { ...structuredClone(previous), familyCmsId: family.id, cmsLayout: "products-v1" as const, cmsHash: fingerprint([...owned, family]) };
  });
}
