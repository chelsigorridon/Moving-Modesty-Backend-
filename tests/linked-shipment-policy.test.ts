import assert from "node:assert/strict";
import test from "node:test";
import { linkedCollectionAddressMatches } from "../lib/integrations/bobgo/linked-shipment-policy.ts";
import type { CourierBookingSnapshot } from "../lib/integrations/bobgo/protocol.ts";

const address = { company: "", street_address: "10 Example Road", local_area: "Example", city: "Cape Town", zone: "Western Cape", country: "ZA", code: "7800" };
const contact = { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" };
const snapshot: Pick<CourierBookingSnapshot, "collection" | "providerSlug"> = { providerSlug: "ie", collection: { kind: "pickup_point", contact, address, point: { id: "1156", providerSlug: "ie", name: "TEST Locker" } } };
const raw = { provider_slug: "ie", collection_location_type: "locker", collection_pickup_point_location_id: 1156, collection_address: null };

test("a null sender-locker address is accepted only for its exact verified point and courier", () => {
  assert.equal(linkedCollectionAddressMatches(raw, snapshot), true);
  assert.equal(linkedCollectionAddressMatches({ ...raw, provider_slug: undefined, provider: { slug: "ie" } }, snapshot), true);
  assert.equal(linkedCollectionAddressMatches({ ...raw, collection_address: address }, snapshot), true);
  assert.equal(linkedCollectionAddressMatches({ ...raw, collection_location_type: "counter" }, snapshot), true);
});

test("missing or conflicting pickup identity, courier, route or supplied address cannot bypass verification", () => {
  for (const change of [{ collection_pickup_point_location_id: undefined }, { collection_pickup_point_location_id: 1157 }, { provider_slug: "other" }, { collection_location_type: "door" }, { collection_address: undefined }, { collection_address: {} }, { collection_address: { ...address, code: "9999" } }]) {
    assert.equal(linkedCollectionAddressMatches({ ...raw, ...change }, snapshot), false);
  }
  assert.equal(linkedCollectionAddressMatches(raw, { ...snapshot, providerSlug: "other" }), false);
  assert.equal(linkedCollectionAddressMatches(raw, { ...snapshot, collection: { ...snapshot.collection, point: undefined } }), false);
});

test("door collections still require their full address and cannot use a locker ID as a substitute", () => {
  const door = { ...snapshot, collection: { kind: "door" as const, contact, address } };
  assert.equal(linkedCollectionAddressMatches(raw, door), false);
  assert.equal(linkedCollectionAddressMatches({ collection_address: address }, door), true);
  assert.equal(linkedCollectionAddressMatches({ collection_address: { ...address, code: "9999" } }, door), false);
});
