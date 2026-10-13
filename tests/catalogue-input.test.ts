import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { catalogueDocumentSchema, cataloguePublicationIssues, catalogueCmsPreview, catalogueVariantSku } from "../lib/catalogue-input.ts";

function product() {
  return { name: "TEST Noor", slug: "test-noor", description: "An unpublished test product.", category: "Active hijabs",
    homepageImage: { url: "https://example.com/noor.jpg", alt: "Noor" }, showOnHomepage: true, homepageOrder: 0,
    colours: [{ id: randomUUID(), name: "Black", available: true, photos: [{ url: "https://example.com/black.jpg", alt: "Noor Black" }],
      variants: [{ id: randomUUID(), size: "Small", price: 420, stock: 5, available: true }, { id: randomUUID(), size: "Large", price: 450, stock: 0, available: true }] }] };
}

test("a product range supports distinct prices and stock per colour/size", () => {
  const document = catalogueDocumentSchema.parse(product());
  assert.equal(document.colours[0].variants.length, 2);
  assert.deepEqual(document.colours[0].variants.map(entry => entry.price), [420, 450]);
});
test("renaming a size never changes its generated checkout code", () => {
  const document = product();
  const sku = catalogueCmsPreview(document).colours[0].sizes[0].sku;
  document.name = "Renamed product"; document.colours[0].name = "Sage"; document.colours[0].variants[0].size = "Medium";
  assert.equal(catalogueCmsPreview(document).colours[0].sizes[0].sku, sku);
  assert.notEqual(sku, catalogueVariantSku(document.colours[0].variants[1].id));
});
test("duplicate colour names and duplicate sizes are rejected case insensitively", () => {
  const document = product();
  document.colours.push({ ...document.colours[0], id: randomUUID(), name: " black ", variants: [{ ...document.colours[0].variants[0], id: randomUUID() }] });
  assert.equal(catalogueDocumentSchema.safeParse(document).success, false);
  document.colours.pop(); document.colours[0].variants[1].size = "small";
  assert.equal(catalogueDocumentSchema.safeParse(document).success, false);
});
test("stock, currency precision and identifier collisions are validated", () => {
  for (const price of [-1, 0, 1.001, Number.POSITIVE_INFINITY]) {
    const document = product(); document.colours[0].variants[0].price = price;
    assert.equal(catalogueDocumentSchema.safeParse(document).success, false);
  }
  for (const stock of [-1, 1.5, 100001]) {
    const document = product(); document.colours[0].variants[0].stock = stock;
    assert.equal(catalogueDocumentSchema.safeParse(document).success, false);
  }
  const document = product(); document.colours[0].variants[1].id = document.colours[0].variants[0].id;
  assert.equal(catalogueDocumentSchema.safeParse(document).success, false);
});
test("unsafe image schemes and invalid page addresses are rejected", () => {
  for (const url of ["javascript:alert(1)", "data:image/png;base64,AAAA", "http://example.com/image.jpg", "blob:demo"]) {
    const document = product(); document.homepageImage.url = url;
    assert.equal(catalogueDocumentSchema.safeParse(document).success, false);
  }
  for (const slug of ["../admin", "new product", "Products", "a/b"]) {
    const document = product(); document.slug = slug;
    assert.equal(catalogueDocumentSchema.safeParse(document).success, false);
  }
});
test("drafts can be incomplete but publication checklist identifies missing photos", () => {
  const document = product(); document.description = ""; document.homepageImage.url = ""; document.colours[0].photos = [];
  assert.equal(catalogueDocumentSchema.safeParse(document).success, true);
  assert.equal(cataloguePublicationIssues(document).length, 3);
});
test("CMS projection hides unavailable or zero-stock choices and exposes no stock counts", () => {
  const document = product();
  let preview = catalogueCmsPreview(document);
  assert.deepEqual(preview.colours[0].sizes.map(entry => entry.available), [true, false]);
  assert.equal("stock" in preview.colours[0].sizes[0], false);
  document.colours[0].available = false;
  preview = catalogueCmsPreview(document);
  assert.deepEqual(preview.colours[0].sizes.map(entry => entry.available), [false, false]);
});
test("care and delivery content is retained in the CMS projection", () => {
  const document = { ...product(), tagline: "Move freely", productDetails: "Tie-back", fabricMaterials: "Mesh", careInstructions: "Hand wash", deliveryReturns: "Contact Zarina" };
  const preview = catalogueCmsPreview(catalogueDocumentSchema.parse(document));
  assert.equal(preview.product.careInstructions, "Hand wash");
  assert.equal(preview.product.deliveryReturns, "Contact Zarina");
});
