import { z } from "zod";

export const waybillChangeInput = z.object({
  action: z.enum(["cancel_waybill", "check_cancellation", "prepare_replacement"]),
  expectedRevision: z.number().int().nonnegative(),
  expectedWaybill: z.string().regex(/^[a-z0-9/_-]{1,100}$/i),
  confirm: z.literal(true),
});

type Shipment = { providerShipmentId?: string | null; trackingNumber?: string | null; provider?: string; shipmentProvider?: string; courierStatus?: string | null };
type History = { action: string; after: unknown };
export const handedOverStatuses = new Set(["collected", "at-hub", "in-transit", "at-destination-hub", "out-for-delivery", "ready-for-pickup", "delivered", "finalised", "returned-to-sender", "delivery-exception", "failed-delivery"]);
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
// A cancellation fence belongs to a particular remote waybill, not the reusable
// local shipment row. It survives timeouts, refreshes and separate admin sessions.
export function cancellationRequested(history: History[], shipment?: Shipment | null) {
  return Boolean(shipment?.providerShipmentId && shipment.trackingNumber && history.some(row => {
    const saved = object(row.after);
    return row.action === "waybill_cancel_requested" && saved.providerShipmentId === shipment.providerShipmentId
      && saved.trackingNumber === shipment.trackingNumber && saved.provider === (shipment.provider || shipment.shipmentProvider);
  }));
}
export function canCancelProviderShipment(remote: Record<string, unknown>, pickupCollection: boolean) {
  if (remote.collected_date || remote.delivered_date || ["failed-indefinitely", "no-rates"].includes(String(remote.submission_status))) return false;
  const eligible = pickupCollection ? ["", "awaiting-dropoff", "cancelled-by-courier"]
    : ["", "pending-collection", "awaiting-dropoff", "failed-collection", "collection-exception", "cancelled-by-courier"];
  return eligible.includes(typeof remote.status === "string" ? remote.status : "");
}
export function previousWaybills(history: Array<History & { before: unknown; createdAt: Date }>) {
  return history.filter(row => row.action === "waybill_replacement_prepared").map(row => {
    const old = object(object(row.before).shipment), snapshot = object(old.bookingSnapshot);
    return { trackingNumber: String(old.trackingNumber || ""), courierName: String(snapshot.providerName || "Bob Go"),
      status: "Cancelled", replacedAt: row.createdAt.toISOString() };
  });
}
