import assert from "node:assert/strict";
import test from "node:test";
import {
  addProductSize, catalogueEditorErrors, changeUsualPrice, newProductColour, productAddress,
  productAvailability, productSizes, renameProductSize, usualProductPrice, variantAvailable, withProductColours,
} from "../lib/catalogue-editor.ts";

function product() {
  return { name: "TEST Noor", slug: "test-noor", description: "Unpublished product", category: "Hijabs",
    homepageImage: { url: "", alt: "" }, showOnHomepage: true, homepageOrder: 0,
    colours: [newProductColour(["Small", "Large"], 420), newProductColour(["Small", "Large"], 420)] };
}
test("preview availability treats uncounted stock like the live storefront without overriding size switches", () => {
  const entry = newProductColour(["Small"], 450).variants[0];
  assert.equal(variantAvailable({ ...entry, stock: 0, stockVerified: false }), true);
  assert.equal(variantAvailable({ ...entry, stock: 0, stockVerified: true }), false);
  assert.equal(variantAvailable({ ...entry, stock: 0 }), false);
  assert.equal(variantAvailable({ ...entry, stock: 8, stockVerified: true }), true);
  assert.equal(variantAvailable({ ...entry, available: false, stock: 8, stockVerified: false }), false);
});
test("page addresses are automatic, bounded and unique, including accented and non-Latin names", () => {
  assert.equal(productAddress("Noor Active Hijab"), "noor-active-hijab");
  assert.equal(productAddress("Noor", ["noor", "noor-2"]), "noor-3");
  assert.equal(productAddress("Café"), "cafe");
  assert.equal(productAddress("نور"), "product");
  assert.equal(productAddress("A", ["a-product"]), "a-product-2");
  assert.ok(productAddress("long".repeat(100)).length <= 140);
});
test("usual price changes preserve deliberate exceptions, identifiers and stock", () => {
  const original = product(); original.colours[0].variants[1].price = 475; original.colours[0].variants[0].stock = 8;
  assert.equal(usualProductPrice(original), 420);
  const changed = changeUsualPrice(original, 420, 450);
  assert.deepEqual(changed.colours.map(colour => colour.variants.map(entry => entry.price)), [[450, 475], [450, 450]]);
  assert.equal(changed.colours[0].variants[0].id, original.colours[0].variants[0].id);
  assert.equal(changed.colours[0].variants[0].stock, 8);
  assert.equal(original.colours[0].variants[0].price, 420);
});
test("new colours inherit shared sizes and price without inheriting stock or identifiers", () => {
  const original = product(); original.colours[0].variants[0].stock = 9;
  const added = newProductColour(productSizes(original), usualProductPrice(original));
  assert.deepEqual(added.variants.map(entry => [entry.size, entry.price, entry.stock]), [["Small", 420, 0], ["Large", 420, 0]]);
  assert.notEqual(added.variants[0].id, original.colours[0].variants[0].id);
});
test("adding and renaming shared sizes preserves existing variant identities and fixes duplicate names by position", () => {
  const original = product();
  const added = addProductSize(original, "Medium", 450);
  assert.equal(added.colours[0].variants[0].id, original.colours[0].variants[0].id);
  assert.equal(added.colours[1].variants[2].price, 450);
  assert.notEqual(added.colours[0].variants[2].id, added.colours[1].variants[2].id);
  const duplicate = renameProductSize(added, "Large", "Small", 1);
  const fixed = renameProductSize(duplicate, "Small", "Large", 1);
  assert.deepEqual(fixed.colours[0].variants.map(entry => entry.size), ["Small", "Large", "Medium"]);
  assert.equal(fixed.colours[0].variants[1].id, original.colours[0].variants[1].id);
});
test("the first uploaded colour photo becomes the collection photo and removals select a valid fallback", () => {
  const original = product();
  const colours = structuredClone(original.colours);
  colours[0].photos = [{ url: "https://example.com/black.jpg", alt: "Black" }];
  colours[1].photos = [{ url: "https://example.com/lavender.jpg", alt: "Lavender" }];
  const selected = withProductColours(original, colours);
  assert.equal(selected.homepageImage.url, colours[0].photos[0].url);
  const removed = withProductColours(selected, colours.slice(1));
  assert.equal(removed.homepageImage.url, colours[1].photos[0].url);
  const custom = { ...selected, homepageImage: { url: "https://example.com/collection.jpg", alt: "Collection" } };
  assert.equal(withProductColours(custom, colours.slice(1)).homepageImage.url, custom.homepageImage.url);
});
test("field errors are friendly and demo blob previews never weaken server image validation", () => {
  const original = product(); original.colours[0].name = "Black"; original.colours[1].name = "Lavender";
  original.colours[0].photos = [{ url: "blob:local-demo", alt: "Photo" }];
  assert.deepEqual(catalogueEditorErrors(original, true), {});
  assert.ok(catalogueEditorErrors(original, false)["colours.0.photos.0.url"]);
  original.colours[0].variants[0].stock = -1;
  assert.match(catalogueEditorErrors(original, true)["colours.0.variants.0.stock"], /whole stock quantity/);
  original.colours[1].name = " black ";
  assert.match(catalogueEditorErrors(original, true)["colours.1.name"], /already exists/);
});
test("availability distinguishes stock exhaustion from an intentionally paused product", () => {
  const original = product(); assert.equal(productAvailability(original), "Out of stock");
  original.colours[0].variants[0].stock = 5; assert.equal(productAvailability(original), "Available");
  original.colours.forEach(colour => { colour.available = false; }); assert.equal(productAvailability(original), "Unavailable");
  original.colours.forEach(colour => { colour.available = true; colour.variants.forEach(entry => { entry.available = false; }); });
  assert.equal(productAvailability(original), "Unavailable");
});
