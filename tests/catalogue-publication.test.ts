import assert from "node:assert/strict";
import test from "node:test";
import { catalogueDocumentSchema } from "../lib/catalogue-input.ts";
import { inventoryOnlyPublication } from "../lib/catalogue-publication.ts";
import { readFileSync } from "node:fs";

const baseline = () => catalogueDocumentSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/catalogue-test-product.json", import.meta.url), "utf8")));
test("only stock counts, counted-state and availability use backend-only publication", () => {
  const original = baseline();
  const edited = structuredClone(original);
  edited.colours[0].available = !edited.colours[0].available;
  edited.colours[0].variants[0].available = !edited.colours[0].variants[0].available;
  edited.colours[0].variants[0].stock = 0;
  edited.colours[0].variants[0].stockVerified = true;
  assert.equal(inventoryOnlyPublication(edited, original), true);
  assert.equal(inventoryOnlyPublication(original, edited), true, "Restoring availability uses the same safe path");
  assert.equal(inventoryOnlyPublication(original, null), false, "A new product must publish to CMS first");
});
test("content, price, identity and ordering changes cannot bypass Framer", () => {
  const original = baseline();
  const edits = [
    (d: typeof original) => { d.name += " edited"; },
    (d: typeof original) => { d.description += " edited"; },
    (d: typeof original) => { d.homepageOrder++; },
    (d: typeof original) => { d.showOnHomepage = !d.showOnHomepage; },
    (d: typeof original) => { d.homepageImage.url = "https://example.com/new.jpg"; },
    (d: typeof original) => { d.colours[0].name += " edited"; },
    (d: typeof original) => { d.colours[0].photos = []; },
    (d: typeof original) => { d.colours[0].variants[0].price++; },
    (d: typeof original) => { d.colours[0].variants[0].size += " edited"; },
    (d: typeof original) => { d.colours[0].variants[0].id = crypto.randomUUID(); },
    (d: typeof original) => { d.colours.reverse(); },
    (d: typeof original) => { d.colours[0].variants.push({ ...d.colours[0].variants[0], id: crypto.randomUUID(), size: "Extra size" }); },
  ];
  for (const edit of edits) {
    const edited = structuredClone(original); edit(edited);
    assert.equal(inventoryOnlyPublication(edited, original), false);
  }
});
