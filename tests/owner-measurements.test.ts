import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { movingModestyBoxPreset, zarinaProductMeasurements, zarinaPackedReferences, zarinaProductMeasurement } from "../lib/shipping/owner-measurements.ts";
import { HAWA_AND_AMINA_PACKAGE, resolveVerifiedPackage } from "../lib/shipping/packages.ts";

test("Zarina's individual, packed and box measurements stay separate", () => {
  assert.deepEqual(zarinaProductMeasurements.map(row => [row.size, row.productGrams, row.singlePackedGrams]),
    [["Small", 126, 183], ["Large", 145, 200], ["One size fits all", 212, 267]]);
  assert.deepEqual(movingModestyBoxPreset, { id: "moving-modesty-scarf-box", name: "Moving Modesty scarf box", lengthCm: 25, widthCm: 20, heightCm: 3 });
  assert.equal("weightGrams" in movingModestyBoxPreset, false, "The box must never fix the final packed weight");
  assert.deepEqual(zarinaPackedReferences.map(row => [row.grams, row.approximate]), [[183, false], [200, false], [267, false], [305, true], [335, false], [393, false]]);
});

test("only known product and size names receive product-only weight suggestions", () => {
  for (const product of ["Hawa", "HAWA TRI-INSTANT SCARF", "  hawa tri instant  "]) {
    assert.equal(zarinaProductMeasurement(product, " small ")?.productGrams, 126);
    assert.equal(zarinaProductMeasurement(product, "L")?.productGrams, 145);
  }
  for (const product of ["Amina", "AMINA TIE-BACK SCARF"]) assert.equal(zarinaProductMeasurement(product, "One size fits all")?.productGrams, 212);
  for (const [product, size] of [["Hawa", "Small / Large"], ["Amina", "Small"], ["Hawa hat", "Small"], ["Future product", "Large"]]) {
    assert.equal(zarinaProductMeasurement(product, size), undefined, "Unknown products and sizes must stay untouched");
  }
});

test("new Hawa plus Amina defaults use Zarina's latest reference without assuming other combinations", () => {
  assert.deepEqual(HAWA_AND_AMINA_PACKAGE, { weightGrams: 393, lengthCm: 25, widthCm: 20, heightCm: 3 });
  for (const size of ["S", "L"]) assert.deepEqual(resolveVerifiedPackage([{ sku: `HAWA-BLK-${size}`, quantity: 1 }, { sku: "AMINA-LAV-OS", quantity: 1 }]), HAWA_AND_AMINA_PACKAGE);
  assert.equal(resolveVerifiedPackage([{ sku: "AMINA-BLK-OS", quantity: 2 }]), null);
  assert.equal(resolveVerifiedPackage([{ sku: "HAWA-BLK-S", quantity: 2 }, { sku: "AMINA-LAV-OS", quantity: 1 }]), null);
});

test("the Framer portal embeds the exact shared packing references without local imports or named exports", () => {
  const source = readFileSync(new URL("../lib/shipping/owner-measurements.ts", import.meta.url), "utf8").replace(/^export (?=(?:const|function)\b)/gm, "").trim();
  const portal = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
  const embedded = portal.split("// BEGIN_MM_PACKING_REFERENCE\n")[1]?.split("// END_MM_PACKING_REFERENCE")[0]?.trim();
  assert.equal(embedded, source);
  assert.doesNotMatch(portal, /from "\.\.\/lib\/shipping\/owner-measurements"/);
  assert.equal((portal.match(/const movingModestyBoxPreset =/g) || []).length, 1);
});
