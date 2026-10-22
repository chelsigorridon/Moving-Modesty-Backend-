import { readFileSync, writeFileSync } from "node:fs";
const target = new URL("../framer/AdminPortal.tsx", import.meta.url);
let portal = readFileSync(target, "utf8");
for (const [name, file, original, embedded] of [
  ["PACKING_REFERENCE", "../lib/shipping/owner-measurements.ts", "", ""],
  ["COLLECTION_SCHEDULE", "../lib/shipping/collection-schedule.ts", "", ""],
  ["DELIVERY_EDITOR", "delivery-editor.tsx", "DeliveryEditor", "EmbeddedDeliveryEditor"],
  ["DELIVERY_PROGRESS", "delivery-progress.tsx", "DeliveryProgress", "EmbeddedDeliveryProgress"],
  ["DELIVERY_STEP_FLOW", "delivery-step-flow.tsx", "DeliveryStepFlow", "EmbeddedDeliveryStepFlow"],
  ["DELIVERY_ADVANCED_SETTINGS", "delivery-advanced-settings.tsx", "DeliveryAdvancedSettings", "EmbeddedDeliveryAdvancedSettings"],
  ["ORDER_SYNC_STATUS", "order-sync-status.tsx", "OrderSyncStatus", "EmbeddedOrderSyncStatus"],
  ["PARCEL_EDITOR", "parcel-editor.tsx", "ParcelEditor", "EmbeddedParcelEditor"],
  ["SHIPPING_WEIGHT_SETTINGS", "shipping-weight-settings.tsx", "ShippingWeightSettings", "EmbeddedShippingWeightSettings"],
]) {
  const begin = `// BEGIN_MM_${name}`, end = `// END_MM_${name}`;
  portal = portal.replace(new RegExp(`\\n${begin}[\\s\\S]*?${end}\\n?`), "");
  let source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
  source = source.replace(/^"use client";\s*/m, "").replace(/^import[^\n]+from "react";\s*/m, "")
    .replace(/^import[^\n]+from "\.\.\/lib\/shipping\/(?:owner-measurements|collection-schedule)";\s*/gm, "");
  if (original) source = source.replace(`export default function ${original}`, `function ${embedded}`);
  if (name === "PACKING_REFERENCE") source = source.replace(/^export (?=(?:const|function)\b)/gm, "");
  if (name === "COLLECTION_SCHEDULE") source = source.replace(/^export (?=(?:type|function)\b)/gm, "");
  portal = `${portal.trimEnd()}\n\n${begin}\n${source.trim()}\n${end}\n`;
}
writeFileSync(target, portal);
console.log("Shared delivery editor bundled into AdminPortal.tsx.");
