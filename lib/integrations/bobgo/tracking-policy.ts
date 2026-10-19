import { record, textValue, type CourierBookingSnapshot } from "./protocol.ts";

export class ShipmentReadbackError extends Error {
  constructor() {
    super("The shipment could not be matched safely. Use Check shipment status or ask your website administrator to check it. Do not book another waybill.");
    this.name = "ShipmentReadbackError";
  }
}
export const courierStatuses = new Set([
  "pending-collection", "awaiting-dropoff", "collected", "at-hub", "in-transit", "at-destination-hub",
  "out-for-delivery", "ready-for-pickup", "delivered", "finalised", "returned-to-sender",
  "collection-exception", "delivery-exception", "failed-collection", "failed-delivery", "cancelled", "cancelled-by-courier",
]);
export type ShipmentIdentity = {
  providerShipmentId: string | null; trackingNumber: string | null; waybillReference: string | null;
  bookingSnapshot: CourierBookingSnapshot | null; serviceLevelCode: string | null;
};
export function shipmentList(value: unknown) {
  const rows = record(value).shipments;
  if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new ShipmentReadbackError();
  return rows.map(record);
}
export function verifiedShipment(value: unknown, local: ShipmentIdentity, orderNumber: string, now: number) {
  const remote = record(value), id = textValue(remote.id), tracking = textValue(remote.tracking_reference);
  if (!/^[1-9]\d{0,18}$/.test(id) || !/^[a-z0-9/_-]{1,100}$/i.test(tracking)) throw new ShipmentReadbackError();
  if (local.providerShipmentId ? id !== local.providerShipmentId :
    !local.waybillReference || remote.custom_tracking_reference !== local.waybillReference || record(remote.meta).custom_order_number !== orderNumber) throw new ShipmentReadbackError();
  // Before a tracking number was saved, the attempt reference and order number
  // must also agree. A numeric ID alone is not enough after a credential change.
  if (!local.trackingNumber && (!local.waybillReference || remote.custom_tracking_reference !== local.waybillReference
    || record(remote.meta).custom_order_number !== orderNumber)) throw new ShipmentReadbackError();
  const customOrder = record(remote.meta).custom_order_number;
  // Linked bookings were independently verified through the full remote order
  // fulfilment. Their known shipment ID + tracking pair is authoritative; the
  // standalone custom_order_number display field is not their association.
  if (!local.bookingSnapshot?.linkedOrder && customOrder !== undefined && customOrder !== orderNumber) throw new ShipmentReadbackError();
  if (local.trackingNumber && tracking !== local.trackingNumber) throw new ShipmentReadbackError();
  if (local.serviceLevelCode && remote.service_level_code !== local.serviceLevelCode) throw new ShipmentReadbackError();
  if (local.bookingSnapshot && remote.provider_slug !== local.bookingSnapshot.providerSlug) throw new ShipmentReadbackError();
  const submission = textValue(remote.submission_status);
  if (!["pending-rates", "pending-submission", "success", "no-rates", "failed-will-retry", "failed-indefinitely"].includes(submission)) throw new ShipmentReadbackError();
  const status = textValue(remote.status);
  if (status && !courierStatuses.has(status)) throw new ShipmentReadbackError();
  const rawTime = remote.tracking_last_event_time || remote.time_modified;
  const statusAt = rawTime ? new Date(textValue(rawTime)) : new Date(now);
  if (!Number.isFinite(statusAt.getTime()) || statusAt.getTime() > now + 300_000) throw new ShipmentReadbackError();
  let chargedAmount: string | undefined;
  if (remote.charged_amount !== undefined && remote.charged_amount !== null) {
    const amount = Number(remote.charged_amount);
    if (remote.charged_amount === "" || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new ShipmentReadbackError();
    chargedAmount = amount.toFixed(2);
  }
  return { id, tracking, submission, status, statusAt, chargedAmount, booked: submission === "success" };
}
