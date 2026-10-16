import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCartSku, normalizeStorefrontCart } from "../lib/storefront-cart.ts";

const lavender = { id: "amina-lavender::one-size", sku: undefined as string | undefined, name: "Amina Tie-Back - Lavender", colour: "Lavender", size: "One size fits all", quantity: 4, price: 420, image: "photo.jpg" };

test("legacy and current identities merge by SKU without losing quantity or metadata", () => {
  const original = [lavender, { ...lavender, id: "AMINA-LAV-OS", sku: " amina-lav-os ", quantity: 1 }];
  const merged = normalizeStorefrontCart(original);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "AMINA-LAV-OS");
  assert.equal(merged[0].sku, "AMINA-LAV-OS");
  assert.equal(merged[0].quantity, 5);
  assert.equal(merged[0].price, 420);
  assert.equal(merged[0].image, "photo.jpg");
  assert.equal(original[0].id, lavender.id);
  assert.equal(original[0].quantity, 4);
  assert.deepEqual(normalizeStorefrontCart(merged), merged);
});

test("different colours and sizes never merge and future products use their explicit SKU", () => {
  const base = { id: "old", sku: undefined as string | undefined, name: "Hawa", colour: "Grey", size: "Small", quantity: 1 };
  const lines = normalizeStorefrontCart([base, { ...base, id: "large", size: "Large" }, { ...base, id: "pink", colour: "Soft Pink" }, { ...base, id: "future", name: "New scarf", sku: "NEW-001-L" }]);
  assert.deepEqual(lines.map(line => line.sku), ["HAWA-GRY-S", "HAWA-GRY-L", "HAWA-PNK-S", "NEW-001-L"]);
  assert.equal(canonicalCartSku({ ...base, colour: "Gray" }), "HAWA-GRY-S");
});

test("unidentifiable and invalid lines remain visible for validation; quantities are never capped silently", () => {
  const unknown = { ...lavender, name: "Unknown scarf", colour: "Unknown", id: "unknown" };
  const invalid = { ...lavender, quantity: -1 };
  const lines = normalizeStorefrontCart([unknown, invalid, { ...lavender, quantity: 9 }, { ...lavender, quantity: 2 }]);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], unknown);
  assert.deepEqual(lines[1], invalid);
  assert.equal(lines[2].quantity, 11, "stock/checkout validation must reject excess, not silently remove it");
});

test("all three deployed cart consumers contain the exact generated identity rules", async () => {
  const { readFile } = await import("node:fs/promises");
  const shared = (await readFile(new URL("../lib/storefront-cart.ts", import.meta.url), "utf8")).replace(/export function /g, "function ").trim();
  for (const file of ["ProductPurchase", "CartContents", "CheckoutOrderSummary"]) {
    const source = await readFile(new URL(`../framer/${file}.tsx`, import.meta.url), "utf8");
    assert.equal(source.split("// BEGIN GENERATED CART IDENTITY\n")[1]?.split("// END GENERATED CART IDENTITY")[0].trim(), shared);
  }
});
