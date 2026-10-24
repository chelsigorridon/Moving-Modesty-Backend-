import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { catalogueDocumentSchema } from "../lib/catalogue-input.ts";
import { recoverCatalogueStock, catalogueStockBaseline } from "../lib/catalogue-stock-recovery.ts";

function fixture() {
  const document = catalogueDocumentSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/catalogue-test-product.json", import.meta.url), "utf8")));
  document.colours = [document.colours[0]];
  document.colours[0].variants = ["Small", "Large"].map(size => ({ id: crypto.randomUUID(), size, stock: 5, stockVerified: true, price: 420, available: true }));
  const current = document.colours[0].variants.map(v => ({ id: v.id, stockOnHand: v.stock, stockVerified: true }));
  return { document, current, baseline: catalogueStockBaseline(current) };
}
test("recovery refreshes untouched counts and preserves every non-stock draft field", () => {
  const { document, current, baseline } = fixture();
  document.description += " saved edit"; document.colours[0].variants[1].available = false;
  const original = structuredClone(document); current[0].stockOnHand = 4;
  const result = recoverCatalogueStock(document, baseline, current);
  const expected = structuredClone(original); expected.colours[0].variants[0].stock = 4;
  assert.deepEqual(result.document, expected); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(document, original, "Reading cannot mutate the stored draft object");
});
test("deliberate stock edits that conflict with a sale are retained and require explicit review", () => {
  const { document, current, baseline } = fixture();
  document.colours[0].variants[0].stock = 8; current[0].stockOnHand = 4;
  const result = recoverCatalogueStock(document, baseline, current);
  assert.equal(result.document.colours[0].variants[0].stock, 8);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual([result.conflicts[0].currentStock, result.conflicts[0].draftStock], [4, 8]);
});
test("a deliberate count with no competing quantity change is not discarded or flagged", () => {
  const { document, current, baseline } = fixture(); document.colours[0].variants[0].stock = 8;
  const result = recoverCatalogueStock(document, baseline, current);
  assert.equal(result.document.colours[0].variants[0].stock, 8); assert.equal(result.conflicts.length, 0);
});
test("old drafts without a baseline use safe live counts and retain proposals in the review details", () => {
  const { document, current } = fixture(); document.colours[0].variants[0].stock = 8; current[0].stockOnHand = 4;
  const result = recoverCatalogueStock(document, undefined, current);
  assert.equal(result.document.colours[0].variants[0].stock, 4);
  assert.equal(result.conflicts[0].draftStock, 8); assert.equal(result.conflicts[0].currentStock, 4);
});
test("matching proposals and live counts do not create needless conflicts", () => {
  const { document, current, baseline } = fixture(); document.colours[0].variants[0].stock = 4; current[0].stockOnHand = 4;
  assert.equal(recoverCatalogueStock(document, baseline, current).conflicts.length, 0);
  assert.equal(recoverCatalogueStock(document, undefined, current).conflicts.length, 0);
});
test("new draft sizes are preserved and stock is matched by identity rather than array order", () => {
  const { document, current, baseline } = fixture();
  document.colours[0].variants.push({ ...document.colours[0].variants[0], id: crypto.randomUUID(), size: "Medium", stock: 9 });
  current[1].stockOnHand = 2; current.reverse();
  const result = recoverCatalogueStock(document, baseline, current);
  assert.deepEqual(result.document.colours[0].variants.map(v => v.stock), [5, 2, 9]);
  assert.equal(result.conflicts.length, 0);
});
test("uncounted zero and counted zero are distinct states and are merged together with quantity", () => {
  const { document, current } = fixture();
  document.colours[0].variants[0].stock = 0; document.colours[0].variants[0].stockVerified = false;
  current[0].stockOnHand = 0; current[0].stockVerified = false;
  const baseline = catalogueStockBaseline(current); current[0].stockVerified = true;
  const result = recoverCatalogueStock(document, baseline, current);
  assert.equal(result.document.colours[0].variants[0].stock, 0);
  assert.equal(result.document.colours[0].variants[0].stockVerified, true);
  assert.equal(result.conflicts.length, 0);
});
test("an intentional zero count is not overwritten after another sale", () => {
  const { document, current, baseline } = fixture(); document.colours[0].variants[0].stock = 0; current[0].stockOnHand = 4;
  const result = recoverCatalogueStock(document, baseline, current);
  assert.equal(result.document.colours[0].variants[0].stock, 0); assert.equal(result.conflicts.length, 1);
});
