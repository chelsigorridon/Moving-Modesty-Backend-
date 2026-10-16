import { readFileSync, writeFileSync } from "node:fs";
const target = new URL("../framer/AdminPortal.tsx", import.meta.url);
let portal = readFileSync(target, "utf8");
for (const [name, file, original, embedded] of [
  ["DELIVERY_EDITOR", "delivery-editor.tsx", "DeliveryEditor", "EmbeddedDeliveryEditor"],
  ["ORDER_SYNC_STATUS", "order-sync-status.tsx", "OrderSyncStatus", "EmbeddedOrderSyncStatus"],
  ["PARCEL_EDITOR", "parcel-editor.tsx", "ParcelEditor", "EmbeddedParcelEditor"],
  ["SHIPPING_WEIGHT_SETTINGS", "shipping-weight-settings.tsx", "ShippingWeightSettings", "EmbeddedShippingWeightSettings"],
]) {
  const begin = `// BEGIN_MM_${name}`, end = `// END_MM_${name}`;
  portal = portal.replace(new RegExp(`\\n${begin}[\\s\\S]*?${end}\\n?`), "");
  let source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
  source = source.replace(/^"use client";\s*/m, "").replace(/^import[^\n]+from "react";\s*/m, "")
    .replace(`export default function ${original}`, `function ${embedded}`);
  portal = `${portal.trimEnd()}\n\n${begin}\n${source.trim()}\n${end}\n`;
}
writeFileSync(target, portal);
console.log("Shared delivery editor bundled into AdminPortal.tsx.");
