import { record, textValue } from "./protocol.ts";
import { matchRemoteOrder, type BobGoOrderPayload } from "./order-sync-policy.ts";
import { courierContactInput } from "../../delivery-input.ts";

export type WaybillLinkErrorCode = "fulfillment_lookup_failed" | "fulfillment_mismatch" | "fulfillment_multiple" | "fulfillment_conflict";
export class WaybillLinkError extends Error {
  readonly code: WaybillLinkErrorCode;
  constructor(code: WaybillLinkErrorCode = "fulfillment_mismatch") { super("The existing Bob Go waybill needs checking. No booking was requested."); this.code = code; }
}
const id = (value: unknown) => /^[1-9]\d{0,18}$/.test(textValue(value)) ? textValue(value) : "";
const normal = (value: unknown) => textValue(value).trim().replace(/\s+/g, " ").toLowerCase();

// Bob Go's GET /order-fulfillments returns shipment fulfilments of an existing
// numeric Bob Go order, not of a website order number. Fail closed on partial,
// return, collection, unknown or multiple fulfilments: the portal has one outbound
// shipment slot and must never silently claim that a split order is fully shipped.
export function existingWaybillReference(value: unknown, remoteOrder: unknown, expected: BobGoOrderPayload) {
  const remote = record(remoteOrder), remoteId = matchRemoteOrder(remote, expected);
  if (!remoteId) throw new WaybillLinkError();
  const body = record(value), entries = body.order_fulfillments;
  if (!Array.isArray(entries) || entries.length > 100 || body.has_more === true
    || body.next_page || (body.total !== undefined && Number(body.total) !== entries.length)) throw new WaybillLinkError();
  if (!entries.length) return null;
  if (entries.length !== 1) throw new WaybillLinkError("fulfillment_multiple");
  const entry = record(entries[0]), fulfillment = entry.order_fulfillment === undefined ? entry : record(entry.order_fulfillment);
  if (id(fulfillment.order_id) !== remoteId || fulfillment.method !== "shipment" || fulfillment.status !== "success"
    || (fulfillment.channel_order_number !== undefined && fulfillment.channel_order_number !== expected.channel_order_number)
    || fulfillment.is_return === true || fulfillment.return_id || fulfillment.return_order_id) throw new WaybillLinkError();
  const shipmentId = id(fulfillment.method_id), trackingNumber = textValue(fulfillment.method_reference);
  if (!shipmentId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(trackingNumber)) throw new WaybillLinkError();
  const items = Array.isArray(fulfillment.order_items) ? fulfillment.order_items : fulfillment.items;
  const orderItems = remote.order_items as unknown[];
  if (!Array.isArray(items) || items.length !== orderItems.length) throw new WaybillLinkError();
  const quantities = new Map<string, number>();
  for (const value of orderItems) {
    const item = record(value), itemId = id(item.id);
    if (!itemId || quantities.has(itemId)) throw new WaybillLinkError();
    quantities.set(itemId, Number(item.qty));
  }
  const seen = new Set<string>();
  for (const value of items) {
    const item = record(value), itemId = id(item.order_item_id ?? item.id), quantity = Number(item.fulfilled_qty ?? item.qty);
    if (!itemId || seen.has(itemId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantities.get(itemId) !== quantity) throw new WaybillLinkError();
    seen.add(itemId);
  }
  const embedded = record(entry.shipment);
  if ((embedded.id !== undefined && id(embedded.id) !== shipmentId)
    || (embedded.tracking_reference !== undefined && embedded.tracking_reference !== trackingNumber)) throw new WaybillLinkError();
  return { shipmentId, trackingNumber };
}

// A fulfilment alone is not a confirmed booking: independently read its shipment
// by ID and require the matching waybill, recipient address and successful submission.
export function verifiedExistingWaybill(value: unknown, reference: { shipmentId: string; trackingNumber: string }, expected: BobGoOrderPayload, now: number) {
  const row = record(value), address = record(row.delivery_address), provider = record(row.provider);
  const providerSlug = textValue(row.provider_slug || provider.slug), providerName = textValue(provider.name || row.provider_name || providerSlug);
  const created = new Date(textValue(row.time_created));
  if (id(row.id) !== reference.shipmentId || row.tracking_reference !== reference.trackingNumber || row.submission_status !== "success"
    || !["door", "locker", "counter"].includes(textValue(row.collection_location_type))
    || !["door", "locker", "counter"].includes(textValue(row.delivery_location_type))
    || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(providerSlug) || providerName.length > 160
    || (row.provider_slug && provider.slug && row.provider_slug !== provider.slug)
    || !/^[A-Za-z0-9_-]{1,80}$/.test(textValue(row.service_level_code))
    || !["pending-collection", "collected", "at-hub", "in-transit", "at-destination-hub", "out-for-delivery", "delivered", "delivery-exception"].includes(textValue(row.status))
    || normal(row.delivery_contact_name) !== normal(`${expected.customer_name} ${expected.customer_surname}`)
    || normal(row.delivery_contact_email) !== normal(expected.customer_email)
    || courierContactInput.shape.phone.safeParse(row.delivery_contact_mobile_number).data !== expected.customer_phone
    || row.is_return === true || row.return_order_id
    || !Number.isFinite(created.getTime()) || created.getTime() > now + 300000) throw new WaybillLinkError();
  for (const key of ["street_address", "local_area", "city", "country", "code", "zone"] as const) {
    if (normal(address[key]) !== normal(expected.delivery_address[key])) throw new WaybillLinkError();
  }
  return { ...reference, providerSlug, providerName, serviceCode: textValue(row.service_level_code), bookedAt: created,
    collectionKind: row.collection_location_type === "door" ? "door" : "pickup_point",
    deliveryKind: row.delivery_location_type === "door" ? "door" : "pickup_point" };
}
