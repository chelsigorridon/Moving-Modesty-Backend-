// Mechanical single-file bundling; Framer cannot import workspace modules.
import { readFileSync, writeFileSync } from "node:fs";
const begin = "// BEGIN GENERATED CART IDENTITY";
const end = "// END GENERATED CART IDENTITY";
const shared = readFileSync(new URL("../lib/storefront-cart.ts", import.meta.url), "utf8").replace(/export function /g, "function ");
for (const file of ["ProductPurchase", "CartContents", "CheckoutOrderSummary"]) {
  const path = new URL(`../framer/${file}.tsx`, import.meta.url);
  const source = readFileSync(path, "utf8").replace(new RegExp(`\\n${begin}[\\s\\S]*?${end}\\n?`), "");
  writeFileSync(path, `${source.trimEnd()}\n\n${begin}\n${shared}\n${end}\n`);
}
console.log("Bundled canonical cart identity into three Framer components.");
