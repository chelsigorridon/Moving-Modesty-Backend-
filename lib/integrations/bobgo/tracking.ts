import "server-only";
import { eq } from "drizzle-orm";
import { requireDatabase } from "../../db";
import { orders, shipments } from "../../db/schema";
import { shipmentList, ShipmentReadbackError, verifiedShipment } from "./tracking-policy";

// Deliberately independent of sales-channel order sync. The provider capability
// here is GET only; neither a webhook nor a status refresh can book a courier.
export function createDirectShipmentTracking(database: ReturnType<typeof requireDatabase>, environment: "production" | "sandbox",
  read: (path: string) => Promise<unknown>, clock = () => Date.now()) {
  async function refresh(shipmentId: string) {
    const [local] = await database.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
    if (!local || local.provider !== `bobgo-${environment}` || !["booking", "booked"].includes(local.status)) throw new ShipmentReadbackError();
    const [order] = await database.select({ id: orders.id, number: orders.orderNumber }).from(orders).where(eq(orders.id, local.orderId)).limit(1);
    if (!order) throw new ShipmentReadbackError();
    const checkedAt = new Date(clock());
    const query = local.providerShipmentId ? new URLSearchParams({ id: local.providerShipmentId, limit: "2", offset: "0" })
      : new URLSearchParams({ start_date: new Date(local.updatedAt.getTime() - 5 * 60_000).toISOString(),
        end_date: new Date(checkedAt.getTime() + 5 * 60_000).toISOString(), limit: "100", offset: "0" });
    const rows = shipmentList(await read(`/shipments?${query}`));
    // A full page cannot prove an uncertain POST was absent. Never unlock it.
    if (!local.providerShipmentId && rows.length === 100) throw new ShipmentReadbackError();
    const matches = rows.filter(row => local.providerShipmentId ? String(row.id) === local.providerShipmentId : row.custom_tracking_reference === local.waybillReference);
    if (matches.length !== 1) throw new ShipmentReadbackError();
    const remote = verifiedShipment(matches[0], local, order.number, clock());
    return database.transaction(async tx => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, local.orderId)).for("update");
      const [current] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
      if (!current || current.provider !== local.provider || !["booking", "booked"].includes(current.status)
        || current.providerShipmentId !== local.providerShipmentId || current.trackingNumber !== local.trackingNumber
        || current.waybillReference !== local.waybillReference) throw new ShipmentReadbackError();
      if (current.courierCheckedAt && current.courierCheckedAt > checkedAt) return { status: "unchanged" };
      if (current.status === "booked" && !remote.booked) throw new ShipmentReadbackError();
      const updateStatus = remote.status && (!current.courierStatusAt || remote.statusAt >= current.courierStatusAt)
        && !(["delivered", "finalised"].includes(current.courierStatus || "") && !["delivered", "finalised", "returned-to-sender"].includes(remote.status));
      const cancelled = updateStatus && ["cancelled", "cancelled-by-courier"].includes(remote.status);
      await tx.update(shipments).set({ providerShipmentId: remote.id, trackingNumber: remote.tracking, waybillReference: remote.tracking,
        trackingUrl: "https://track.bobgo.co.za/", status: cancelled ? "cancelled" : remote.booked ? "booked" : "booking",
        bookedAt: remote.booked ? current.bookedAt || checkedAt : null, courierCheckedAt: checkedAt,
        ...(updateStatus ? { courierStatus: remote.status, courierStatusAt: remote.statusAt } : {}),
        ...(remote.chargedAmount !== undefined ? { courierChargedAmount: remote.chargedAmount } : {}),
        lastError: remote.booked ? null : `Courier booking: ${remote.submission}. Check shipment status; do not book another waybill.`, updatedAt: new Date(clock()),
      }).where(eq(shipments.id, shipmentId));
      if (remote.booked) await tx.update(orders).set({ courierName: current.bookingSnapshot?.providerName || "Bob Go",
        trackingNumber: remote.tracking, trackingUrl: "https://track.bobgo.co.za/", updatedAt: new Date(clock()) }).where(eq(orders.id, order.id));
      // Never change customer payments, inventory, fulfilment status, or emails.
      return { status: "updated", booked: remote.booked && !cancelled, courierStatus: updateStatus ? remote.status : current.courierStatus, submissionStatus: remote.submission };
    });
  }
  return { refresh };
}
