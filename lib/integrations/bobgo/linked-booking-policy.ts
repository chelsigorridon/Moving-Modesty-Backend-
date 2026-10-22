import { bobGoAddressesMatch, normalizeBobGoText } from "./address-policy.ts";
import { courierContactInput } from "../../delivery-input.ts";
import { matchRemoteOrder, stableOrderPayload, type BobGoOrderPayload, type OrderSyncConfiguration } from "./order-sync-policy.ts";
import { fingerprint, parcelPayload, record, textValue, type ApprovedQuote, type CourierBookingSnapshot, type PackedParcel } from "./protocol.ts";
import { linkedCollectionDateFields } from "./linked-collection.ts";
import { newOrderConfiguration } from "./activation-policy.ts";

export class LinkedBookingConflict extends Error {
  constructor(message = "The linked Bob Go order needs checking. No separate shipment will be created.") { super(message); this.name = "LinkedBookingConflict"; }
}
export const linkedBookingPaused = "Linked portal booking is not activated. Keep the existing order in Bob Go; do not create a separate shipment.";
// Manual linked booking has its own release gate. Pausing automatic order
// copying must not force an already-linked order back into standalone shipping.
// Both switches share the same new-order cutoff; booking is always manual.
export function getLinkedBookingConfiguration(): OrderSyncConfiguration {
  return newOrderConfiguration("BOBGO_LINKED_BOOKING_ENABLED");
}
export function remoteId(value: unknown) {
  const id = textValue(value);
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new LinkedBookingConflict();
  return id;
}
export function expectedFingerprint(value: BobGoOrderPayload) { return fingerprint(stableOrderPayload(value)); }
export function linkedOrderMatch(value: unknown, expected: BobGoOrderPayload, snapshot?: Pick<CourierBookingSnapshot, "delivery">) {
  const remote = record(value), point = snapshot?.delivery.point;
  // A pickup-point order may omit delivery_address. Its verified point ID and
  // provider replace that address, never an arbitrary caller-supplied location.
  if (point && textValue(remote.pickup_point_location_id) === point.id && remote.pickup_point_provider_slug === point.providerSlug) {
    return matchRemoteOrder({ ...remote, delivery_address: expected.delivery_address }, expected);
  }
  if (remote.pickup_point_location_id) return null;
  return matchRemoteOrder(remote, expected);
}
export function remoteBookingFingerprint(value: unknown) {
  const remote = record(value), presets = record(remote.order_fulfillment_presets);
  return fingerprint(stableOrderPayload({
    ...Object.fromEntries(["id", "account_id", "channel_id", "channel_order_number", "status", "payment_status", "currency", "customer_name", "customer_surname",
      "customer_email", "customer_phone", "buyer_selected_shipping_cost", "delivery_address", "pickup_point_location_id", "pickup_point_provider_slug", "order_items"].map(key => [key, remote[key]])),
    order_fulfillment_presets: Object.fromEntries(["method", "collection_address_book_id", "parcels", "declared_value", "instructions_collection", "instructions_delivery", "requested_collection_date"].map(key => [key, presets[key]])),
  }));
}
export function assertNoFulfillments(value: unknown) {
  const body = record(value);
  if (!Array.isArray(body.order_fulfillments) || body.order_fulfillments.length || body.has_more === true
    || body.next_page || Number(body.total || body.count || 0) !== 0) throw new LinkedBookingConflict("Bob Go already has a fulfilment, or its status is uncertain. Check the existing waybill; do not book another.");
}
export function collectionBookId(value: unknown, collection: CourierBookingSnapshot["collection"]) {
  const body = record(value), rows = body.items;
  if (!Array.isArray(rows) || rows.length > 100 || body.has_more === true || body.next_page
    || (body.count !== undefined && Number(body.count) > rows.length)) throw new LinkedBookingConflict("The Bob Go collection address list is incomplete. Check saved collection addresses in Bob Go.");
  const matches = rows.filter(value => {
    const row = record(value), point = record(row.pickup_point_location);
    const name = [row.contact_name, row.contact_surname].filter(Boolean).join(" ");
    return row.active !== false && row.is_collection_address !== false && row.pickup_point_active !== false && point.active !== false
      && (collection.point ? true : bobGoAddressesMatch(record(row.address), collection.address))
      && normalizeBobGoText(name) === normalizeBobGoText(collection.contact.name)
      && normalizeBobGoText(row.email ?? row.contact_email) === normalizeBobGoText(collection.contact.email)
      && courierContactInput.shape.phone.safeParse(row.contact_mobile_number ?? row.contact_number ?? row.mobile_number).data === collection.contact.phone
      && (collection.point ? textValue(point.id ?? row.pickup_point_location_id) === collection.point.id
        && textValue(point.provider_slug ?? row.pickup_point_provider_slug) === collection.point.providerSlug
        : !row.pickup_point_location_id && !point.id);
  });
  if (matches.length !== 1) throw new LinkedBookingConflict("Save this exact collection address or drop-off point and contact in Bob Go’s address book first. No address or waybill was created.");
  return remoteId(record(matches[0]).id);
}
export function linkedOrderUpdate(id: string, expected: BobGoOrderPayload, snapshot: CourierBookingSnapshot, parcel: PackedParcel, bookId: string) {
  return { id: Number(remoteId(id)), customer_name: expected.customer_name, customer_surname: expected.customer_surname,
    customer_email: expected.customer_email, customer_phone: expected.customer_phone,
    ...(snapshot.delivery.point ? {} : { delivery_address: expected.delivery_address }),
    pickup_point_location_id: snapshot.delivery.point ? Number(snapshot.delivery.point.id) : null,
    pickup_point_provider_slug: snapshot.delivery.point?.providerSlug || null,
    order_fulfillment_presets: { method: "shipment", collection_address_book_id: Number(remoteId(bookId)),
      parcels: parcelPayload(parcel, expected.channel_order_number), declared_value: 0,
      requested_collection_date: linkedCollectionDateFields(snapshot.collectionSchedule).requested_collection_date ?? null,
      instructions_collection: snapshot.collectionInstructions, instructions_delivery: snapshot.deliveryInstructions } };
}
export function linkedFulfillmentPayload(quote: ApprovedQuote, reference: string) {
  const snapshot = quote.deliverySnapshot, linked = snapshot?.linkedOrder;
  if (quote.version !== 3 || !linked || quote.declaredValue !== 0) throw new LinkedBookingConflict();
  return { order_id: Number(remoteId(linked.remoteOrderId)), items: null, method: "shipment", type: "original", source: "full",
    custom_tracking_reference: reference,
    order_fulfillment_presets: { provider_slug: quote.providerSlug, service_level_code: quote.serviceCode,
      requested_collection_date: linkedCollectionDateFields(snapshot.collectionSchedule).requested_collection_date ?? null,
      declared_value: 0, instructions_collection: snapshot.collectionInstructions, instructions_delivery: snapshot.deliveryInstructions,
      store_location_id: null },
    pickup_point_location_id: snapshot.delivery.point ? Number(snapshot.delivery.point.id) : null,
    pickup_point_provider_slug: snapshot.delivery.point?.providerSlug || null };
}
