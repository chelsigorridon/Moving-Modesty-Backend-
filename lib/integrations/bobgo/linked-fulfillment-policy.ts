import { record, textValue, fingerprint } from "./protocol.ts";
import { existingWaybillReference } from "./waybill-link-policy.ts";
import type { BobGoOrderPayload } from "./order-sync-policy.ts";
import { LinkedBookingConflict, remoteId } from "./linked-booking-policy.ts";

export type RetiredLinkedFulfillment = {
  environment: string; channelRef: string; remoteOrderId: string; fulfillmentId: string; shipmentId: string; trackingNumber: string;
};
type History = { action: string; before: unknown; after: unknown };
export function retiredLinkedFulfillments(history: History[], scope: { environment: string; channelRef: string; remoteOrderId: string }) {
  const result: RetiredLinkedFulfillment[] = [];
  for (const row of history) {
    if (row.action !== "waybill_replacement_prepared" || !record(row.after).linkedCancellation) continue;
    const saved = record(record(row.after).linkedCancellation), previous = record(record(row.before).shipment);
    const link = record(record(previous.bookingSnapshot).linkedOrder);
    if (saved.environment !== scope.environment || saved.channelRef !== scope.channelRef || saved.remoteOrderId !== scope.remoteOrderId
      || previous.provider !== `bobgo-${scope.environment}` || saved.shipmentId !== previous.providerShipmentId || saved.trackingNumber !== previous.trackingNumber
      || link.remoteOrderId !== scope.remoteOrderId || link.channelRef !== scope.channelRef || previous.status !== "cancelled") throw new LinkedBookingConflict("Previous linked-waybill history needs checking before another booking.");
    const item = { ...scope, fulfillmentId: remoteId(saved.fulfillmentId), shipmentId: remoteId(saved.shipmentId), trackingNumber: textValue(saved.trackingNumber) };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(item.trackingNumber) || result.some(row => row.fulfillmentId === item.fulfillmentId || row.shipmentId === item.shipmentId)) throw new LinkedBookingConflict();
    result.push(item);
  }
  if (result.length > 10) throw new LinkedBookingConflict("This order has many replacement waybills. Support must reconcile its history before another booking.");
  return result.sort((a, b) => a.fulfillmentId.localeCompare(b.fulfillmentId));
}
export const retiredFingerprint = (value: RetiredLinkedFulfillment[]) => fingerprint(value);

// Cancelled records are not discarded just because their status says cancelled.
// Only the exact full fulfilments previously verified and archived by the owner
// are retired. A foreign, partial, return or unexplained extra remains a blocker.
export function activeLinkedFulfillments(value: unknown, remote: unknown, expected: BobGoOrderPayload, retired: RetiredLinkedFulfillment[]) {
  const body = record(value), rows = body.order_fulfillments;
  if (!Array.isArray(rows) || rows.length > 100 || body.has_more === true || body.next_page
    || (body.count !== undefined && Number(body.count) !== rows.length) || (body.total !== undefined && Number(body.total) !== rows.length)) throw new LinkedBookingConflict();
  if (!retired.length) return { order_fulfillments: rows, count: rows.length };
  const seen = new Set<string>(), retiredSeen = new Set<string>(), active: unknown[] = [];
  for (const entry of rows) {
    const wrapper = record(entry), fulfillment = wrapper.order_fulfillment === undefined ? wrapper : record(wrapper.order_fulfillment);
    const id = remoteId(fulfillment.id);
    if (seen.has(id)) throw new LinkedBookingConflict(); seen.add(id);
    const old = retired.find(row => row.fulfillmentId === id);
    if (!old) { active.push(entry); continue; }
    if (fulfillment.status !== "cancelled" || String(fulfillment.order_id) !== old.remoteOrderId) throw new LinkedBookingConflict("A previous linked fulfilment is not confirmed cancelled. No new waybill is allowed.");
    const reference = existingWaybillReference({ order_fulfillments: [{ ...wrapper, order_fulfillment: { ...fulfillment, status: "success" } }], count: 1 }, remote, expected);
    if (!reference || reference.shipmentId !== old.shipmentId || reference.trackingNumber !== old.trackingNumber) throw new LinkedBookingConflict();
    retiredSeen.add(id);
  }
  if (retiredSeen.size !== retired.length) throw new LinkedBookingConflict("Bob Go did not return the full previous cancellation history. Check it before another booking.");
  return { order_fulfillments: active, count: active.length };
}
export function linkedFulfillmentReference(value: unknown, remote: unknown, expected: BobGoOrderPayload, allowCancelled = false) {
  const rows = record(value).order_fulfillments;
  if (!Array.isArray(rows) || rows.length !== 1) throw new LinkedBookingConflict("The current linked fulfilment could not be uniquely matched. No waybill was changed.");
  const wrapper = record(rows[0]), fulfillment = wrapper.order_fulfillment === undefined ? wrapper : record(wrapper.order_fulfillment);
  if (fulfillment.status !== "success" && !(allowCancelled && fulfillment.status === "cancelled")) throw new LinkedBookingConflict("The linked fulfilment is still processing or has an unexpected status.");
  const reference = existingWaybillReference({ order_fulfillments: [{ ...wrapper, order_fulfillment: { ...fulfillment, status: "success" } }], count: 1 }, remote, expected);
  if (!reference) throw new LinkedBookingConflict();
  return { ...reference, fulfillmentId: remoteId(fulfillment.id), cancelled: fulfillment.status === "cancelled" };
}
export async function verifyRetiredShipments(retired: RetiredLinkedFulfillment[], read: (id: string) => Promise<unknown>) {
  await Promise.all(retired.map(async row => {
    const shipment = record(await read(row.shipmentId));
    if (String(shipment.id) !== row.shipmentId || shipment.tracking_reference !== row.trackingNumber || shipment.status !== "cancelled"
      || shipment.collected_date || shipment.delivered_date) throw new LinkedBookingConflict("A previous courier booking is not confirmed cancelled. Delivery remains locked.");
  }));
}
