/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Framer API adapter, with no network. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const unifiedFields = {
  Name: "lNaBLbLNF", Description: "ddo9343_D", "Catalogue Tagline": "TGuCVRJQV",
  "Product Details": "details", "Fabric Materials": "fabric", "Care Instructions": "NX_2iSY8r",
  "Delivery Returns": "T6xmlvzLS", Benefits: "benefits", "Fabric Weight": "weight", Dimensions: "dimensions",
  "Product Page": "KlgY5XRMJ", "Is Product Page": "page-info", Featured: "gjnCnMcDz",
  "Show In Catalogue": "EpZSVC1_n", "Has Carousel": "hbuc7C5Db",
};
const legacyFields = Object.fromEntries(Object.keys(unifiedFields).filter(name => !["Catalogue Tagline", "Is Product Page", "Product Page", "Featured", "Show In Catalogue", "Has Carousel"].includes(name)).map(name => [name, `legacy-${name}`]));
legacyFields.Tagline = "legacy-Tagline";
function document(slug = "amina") {
  return { name: slug === "amina" ? "Amina Tie-Back" : "Hawa Tri-Instant", slug,
    description: `Original ${slug} description`, category: "test", tagline: "Original tagline",
    productDetails: "Original details", fabricMaterials: "Original fabric", benefits: "Original benefits",
    fabricWeight: "Original weight", dimensions: "Original dimensions", careInstructions: "Original care",
    deliveryReturns: "Original delivery", homepageImage: { url: "https://test.invalid/cover.jpg", alt: "Original cover" },
    showOnHomepage: true, homepageOrder: 0,
    colours: [{ id: `${slug}-colour-id`, name: "Black", available: true,
      photos: [{ url: "https://test.invalid/black.jpg", alt: "Original black" }],
      variants: [{ id: `${slug}-small-id`, size: slug === "amina" ? "One size fits all" : "Small", price: slug === "amina" ? 420 : 450, stock: 5, stockVerified: true, available: true }] }] };
}
function familyData(doc: any, unified = true) {
  const fields: Record<string, string> = unified ? unifiedFields : legacyFields;
  const data: any = {};
  for (const [name, key] of [["Name", "name"], ["Description", "description"], [unified ? "Catalogue Tagline" : "Tagline", "tagline"],
    ["Product Details", "productDetails"], ["Fabric Materials", "fabricMaterials"], ["Care Instructions", "careInstructions"],
    ["Delivery Returns", "deliveryReturns"], ["Benefits", "benefits"], ["Fabric Weight", "fabricWeight"], ["Dimensions", "dimensions"]]) data[fields[name]] = { type: "string", value: doc[key] };
  if (unified) {
    data["page-info"] = { type: "boolean", value: true };
    data.KlgY5XRMJ = { type: "string", value: doc.slug };
  }
  return data;
}
function colour(doc: any) {
  return { id: `${doc.slug}-black`, slug: `${doc.slug}-black`, draft: false, fieldData: {
    lNaBLbLNF: { type: "string", value: `${doc.name} - Black` },
    gCtlt7Fof: { type: "string", value: `${doc.slug.toUpperCase()}-BLK` },
    UaUoAYeYW: { type: "string", value: `R ${doc.colours[0].variants[0].price}.00` },
    MT9QIiqB2: { type: "string", value: "Black" },
    EpZSVC1_n: { type: "boolean", value: true },
    hv_BclQc4: { type: "string", value: doc.name },
    TGuCVRJQV: { type: "string", value: doc.tagline },
    pN_SP_2Jp: { type: "image", value: { url: "https://test.invalid/black.jpg", altText: "Original black" } },
    NX_2iSY8r: { type: "string", value: doc.careInstructions }, T6xmlvzLS: { type: "string", value: doc.deliveryReturns },
    "page-info": { type: "boolean", value: false },
  } };
}
function mapping(doc: any, layout = "products-v1") {
  return { familyCmsId: doc.slug, cmsLayout: layout, colours: { [doc.colours[0].id]: { cmsId: `${doc.slug}-black`, slug: `${doc.slug}-black`, baseSku: `${doc.slug.toUpperCase()}-BLK` } }, variantSkus: { [doc.colours[0].variants[0].id]: `${doc.slug.toUpperCase()}-BLK-S` } };
}
function harness(options: { legacy?: boolean; pendingCanvas?: boolean; unifiedRows?: boolean; connectError?: string; readError?: string; writeError?: string } = {}) {
  const docs = [document(), document("hawa")];
  const writes: any[] = [], published: any[] = [];
  function collection(id: string, name: string, fields: Record<string, string>, rows: any[]) {
    return { id, name, rows,
      async getFields() { return Object.entries(fields).map(([name, id]) => ({ id, name, type: name === "Is Product Page" ? "boolean" : "string" })); },
      async getItems() { return structuredClone(rows); },
      async addItems(items: any[]) {
        if (options.writeError) throw new Error(options.writeError);
        for (const item of items) {
          writes.push({ collection: name, item: structuredClone(item) });
          const found = rows.find(row => row.id === item.id || row.slug === item.slug);
          if (found) { found.fieldData = { ...found.fieldData, ...item.fieldData }; found.draft = item.draft; }
          else rows.push({ ...structuredClone(item), id: item.id || item.slug });
        }
      },
      async setItemOrder(ids: string[]) { rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); },
    };
  }
  const productRows = docs.flatMap(doc => [colour(doc), ...(options.unifiedRows === false ? [] : [{ id: doc.slug, slug: doc.slug, draft: false, fieldData: familyData(doc) }])]);
  const products = collection("m15OMOfwH", "Products", unifiedFields, productRows);
  const families = collection("legacy-families", "ProductCatalogue", legacyFields, docs.map(doc => ({ id: doc.slug, slug: doc.slug, draft: false, fieldData: familyData(doc, false) })));
  const client = {
    async getProjectInfo() { return { name: "Moving Modesty" }; },
    async getCollections() { if (options.readError) throw new Error(options.readError); return options.legacy ? [products, families] : [products]; },
    async disconnect() {},
    agent: { async publish(input: any) {
      published.push(input);
      return input.action === "preview" ? { status: "ready", changesCount: options.pendingCanvas ? 1 : 0, confirmationHash: "test-only", errors: [], warnings: [] } : { status: "published" };
    } },
  };
  const cache = new Map<string, any>();
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute);
    if (absolute.endsWith("catalogue-drafts.ts")) return { CatalogueConflictError: class extends Error {} };
    if (absolute.endsWith("checkout-catalogue.ts")) return { getCheckoutCatalogue: () => new Map(docs.map(doc => [doc.slug, { sku: `${doc.slug.toUpperCase()}-BLK-S`, colour: "Black", size: doc.colours[0].variants[0].size }])) };
    const compiledModule = { exports: {} }; cache.set(absolute, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name === "framer-api") return { connect: async () => { if (options.connectError) throw new Error(options.connectError); return client; } };
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + ".ts");
      return require(name);
    };
    new Function("require", "module", "exports", compiled)(localRequire, compiledModule, compiledModule.exports);
    return compiledModule.exports;
  }
  return { cms: load("lib/framer-catalogue-live.ts"), docs, products, families, writes, published };
}

test("two-collection catalogue migration preserves legacy and unified publishing safely", async t => {
  const previousKey = process.env.FRAMER_API_KEY;
  process.env.FRAMER_API_KEY = "test-only-mocked-no-network";
  try {
    await t.test("bridge still writes the old collection for unmigrated products", async () => {
      const h = harness({ legacy: true, unifiedRows: false });
      const result = await h.cms.publishCmsCatalogue(h.docs[0], mapping(h.docs[0], "legacy"), ["amina", "hawa"]);
      assert.equal(result.cmsLayout, "legacy");
      assert.ok(h.writes.some(write => write.collection === "ProductCatalogue"));
      assert.equal(h.products.rows.length, 2);
    });
    await t.test("unified page information and colour cards have separate flags", async () => {
      const h = harness();
      const result = await h.cms.publishCmsCatalogue(h.docs[0], mapping(h.docs[0]), ["amina", "hawa"]);
      assert.equal(result.cmsLayout, "products-v1");
      const family = h.products.rows.find(row => row.slug === "amina")!;
      const card = h.products.rows.find(row => row.slug === "amina-black")!;
      assert.equal(family.fieldData["page-info"].value, true);
      assert.equal(family.fieldData.gjnCnMcDz.value, false);
      assert.equal(family.fieldData.EpZSVC1_n.value, false);
      assert.equal(card.fieldData["page-info"].value, false);
      assert.equal(card.fieldData.gCtlt7Fof.value, "AMINA-BLK");
      assert.equal(card.fieldData.hgqgdsqCt.value, "/amina");
      assert.deepEqual(result.variantSkus, mapping(h.docs[0]).variantSkus);
      assert.equal(h.products.rows[0].slug, "amina-black");
    });
    await t.test("explicit unified mappings work while the old collection is retained", async () => {
      const h = harness({ legacy: true });
      await h.cms.publishCmsCatalogue(h.docs[0], mapping(h.docs[0]), ["amina", "hawa"]);
      assert.equal(h.writes.filter(write => write.collection === "ProductCatalogue").length, 0);
    });
    await t.test("a family address cannot overwrite a colour row", async () => {
      const h = harness(); h.products.rows.push({ id: "new-colour", slug: "new-product", draft: false, fieldData: { "page-info": { type: "boolean", value: false } } });
      const doc = document("new-product");
      await assert.rejects(h.cms.publishCmsCatalogue(doc, mapping(doc)), /page address is already used by a colour/);
      assert.equal(h.writes.length, 0);
    });
    await t.test("unrelated unpublished canvas work still blocks publishing", async () => {
      const h = harness({ pendingCanvas: true });
      await assert.rejects(h.cms.publishCmsCatalogue(h.docs[0], mapping(h.docs[0])), /unpublished changes/);
      assert.equal(h.writes.length, 0);
    });
    await t.test("connection failures identify permissions without exposing raw SDK data", async () => {
      const h = harness({ connectError: "This project opened view-only. SECRET-CREDENTIAL-DO-NOT-LOG" });
      await assert.rejects(h.cms.publishCmsCatalogue(h.docs[0], mapping(h.docs[0])), (error: any) => {
        assert.ok(error instanceof h.cms.CataloguePublishPreflightError);
        assert.match(error.message, /current connection.*project permissions/);
        assert.doesNotMatch(error.message, /SECRET-CREDENTIAL/); return true;
      });
      assert.equal(h.writes.length, 0); assert.equal(h.published.length, 0);
    });
    await t.test("read failures before any CMS write are safe preflight failures", async () => {
      const h = harness({ readError: "Internal provider response SECRET-CREDENTIAL-DO-NOT-LOG" });
      await assert.rejects(h.cms.publishCmsCatalogue(h.docs[0], mapping(h.docs[0])), (error: any) => {
        assert.ok(error instanceof h.cms.CataloguePublishPreflightError);
        assert.match(error.message, /live product has not changed/);
        assert.doesNotMatch(error.message, /SECRET-CREDENTIAL/); return true;
      });
      assert.equal(h.writes.length, 0);
    });
    await t.test("an attempted CMS mutation stays uncertain and cannot release checkout", async () => {
      const h = harness({ writeError: "Provider disconnected after accepting a write" });
      await assert.rejects(h.cms.publishCmsCatalogue(h.docs[0], mapping(h.docs[0])), (error: any) => {
        assert.equal(error instanceof h.cms.CataloguePublishPreflightError, false); return true;
      });
    });
    await t.test("reconciliation only reads and rejects altered page content", async () => {
      const h = harness();
      const result = await h.cms.readConsolidatedCmsMapping(h.docs[0], mapping(h.docs[0]));
      assert.equal(result.cmsLayout, "products-v1"); assert.equal(result.familyCmsId, "amina");
      assert.equal(h.writes.length, 0); assert.equal(h.published.length, 0);
      h.products.rows.find(row => row.slug === "amina")!.fieldData.ddo9343_D.value = "Changed by another editor";
      await assert.rejects(h.cms.readConsolidatedCmsMapping(h.docs[0], mapping(h.docs[0])), /does not match/);
    });
    await t.test("unified imports exclude page-information rows from colour variants", async () => {
      const h = harness();
      const existing = h.docs.map(doc => ({ id: `${doc.slug}-product`, slug: doc.slug === "amina" ? "amina-tie-back" : "hawa-tri-instant-scarf", name: doc.name, category: "test" }));
      const stock = h.docs.map(doc => ({ id: doc.colours[0].variants[0].id, productId: `${doc.slug}-product`, colour: "Black", size: doc.colours[0].variants[0].size, stockOnHand: 5, stockVerified: true, active: true }));
      const result = await h.cms.importCmsCatalogue(existing, stock);
      assert.equal(result.length, 2);
      for (const product of result) {
        assert.equal(product.metadata.cmsLayout, "products-v1");
        assert.equal(product.document.colours.length, 1);
        assert.equal(product.document.colours[0].variants.length, 1);
      }
    });
  } finally {
    if (previousKey === undefined) delete process.env.FRAMER_API_KEY;
    else process.env.FRAMER_API_KEY = previousKey;
  }
});
