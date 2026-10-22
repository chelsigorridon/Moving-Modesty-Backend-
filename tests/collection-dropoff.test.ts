import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { configuredCollectionDropOff } from "../lib/shipping/collection-dropoff.ts";
const config = { senderLocationName: "Constantia Emporium", pickupPointLocationId: "1156", pickupPointProviderSlug: "ie" };
test("only the configured sender drop-off reference is returned, with no price, customer location, token or booking authority", () => {
  assert.deepEqual(configuredCollectionDropOff(config), { id: "1156", name: "Constantia Emporium", providerSlug: "ie" });
  for (const change of [{ pickupPointLocationId: undefined }, { pickupPointLocationId: "PASTE_ID" }, { pickupPointLocationId: "0" }, { pickupPointProviderSlug: "../bad" }, { senderLocationName: "" }]) assert.equal(configuredCollectionDropOff({ ...config, ...change }), null);
});
test("the authenticated quote response adds sender drop-off metadata only after actual courier comparison", () => {
  const route = readFileSync(new URL("../app/api/admin/orders/[orderNumber]/shipment/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("getRequestAdmin(request)") < route.indexOf("const body ="));
  assert.match(route, /input.action === "quote" \? \{ collectionDropOff: configuredCollectionDropOff\(getBobGoConfiguration\(\)\) \}/);
  assert.doesNotMatch(route, /collectionDropOff:.*process\.env/);
});
