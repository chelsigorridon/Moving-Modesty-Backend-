import { bobGoAddressesMatch } from "./address-policy.ts";
import { record, textValue, type CourierBookingSnapshot } from "./protocol.ts";

export function linkedCollectionAddressMatches(value: unknown, snapshot: Pick<CourierBookingSnapshot, "collection" | "providerSlug">) {
  const raw = record(value), collection = snapshot.collection;
  if (collection.kind === "door") return bobGoAddressesMatch(record(raw.collection_address), collection.address);
  const point = collection.point;
  // Bob Go returns collection_address:null for a successfully submitted sender
  // locker. Only its exact verified pickup ID/provider may replace that address.
  // A supplied conflicting address, missing ID or different courier still fails.
  return Boolean(point && /^[1-9]\d*$/.test(point.id)
    && ["locker", "counter"].includes(textValue(raw.collection_location_type))
    && textValue(raw.collection_pickup_point_location_id) === point.id
    && point.providerSlug === snapshot.providerSlug
    && textValue(raw.provider_slug || record(raw.provider).slug) === point.providerSlug
    && (raw.collection_address === null || bobGoAddressesMatch(record(raw.collection_address), collection.address)));
}
