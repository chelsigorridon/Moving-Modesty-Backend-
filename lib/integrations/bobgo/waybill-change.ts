import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDatabase } from "../../db";
import { bobgoOrderSync, orderDeliveryHistory, orders, payments, shipments } from "../../db/schema";
import { getBobGoConfiguration } from "./configuration";
import { bobGoRequest } from "./client";
import { cancellationRequested, canCancelProviderShipment, handedOverStatuses, waybillChangeInput } from "./waybill-change-policy";
import { shipmentList, verifiedShipment } from "./tracking-policy";
import { assertCourierTestCanCancel } from "../../live-courier-test";

export class WaybillChangeConflict extends Error {}
type Database = ReturnType<typeof requireDatabase>;
type Shipment = typeof shipments.$inferSelect;
type Order = typeof orders.$inferSelect;
type Input = ReturnType<typeof waybillChangeInput.parse>;

// No shipment creation, rate requests, order imports or emails are available to
// this service. Replacement booking remains the separate, signed-quote workflow.
export function createWaybillChanges(database: Database, config: { enabled: boolean; apiTokenConfigured: boolean; environment: "production" | "sandbox" },
  provider: (path: string, body?: Record<string, unknown>) => Promise<unknown>, clock = () => Date.now()) {
  async function validate(reader: Pick<Database, "select">, order: Order | undefined, shipment: Shipment | undefined, input: Input) {
    if (!config.enabled || !config.apiTokenConfigured) throw new WaybillChangeConflict("Bob Go is not configured for delivery changes.");
    if (!order || order.archivedAt || order.deliveryMethod !== "courier" || order.paymentStatus !== "paid"
      || !["new", "confirmed", "processing", "ready"].includes(order.status)) {
      throw new WaybillChangeConflict("Only active paid delivery orders that have not been handed over can change waybills. Contact Bob Go for a parcel already handed over.");
    }
    if (order.deliveryRevision !== input.expectedRevision) throw new WaybillChangeConflict("This order changed. Refresh it before continuing.");
    if (!shipment || shipment.provider !== `bobgo-${config.environment}` || !/^[1-9]\d{0,18}$/.test(shipment.providerShipmentId || "")
      || shipment.trackingNumber !== input.expectedWaybill || !["booked", "booking", "cancelled"].includes(shipment.status)) {
      throw new WaybillChangeConflict("The current waybill could not be matched. Check shipment status first; do not create another booking.");
    }
    if (handedOverStatuses.has(shipment.courierStatus || "")) throw new WaybillChangeConflict("Courier tracking reports this parcel has been handed over. Arrange changes with Bob Go.");
    const [payment] = await reader.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
    if (!payment || payment.status !== "paid" || !payment.verifiedAt || !payment.providerPaymentId || Number(payment.amount) !== Number(order.total)) throw new WaybillChangeConflict("A matching verified payment in the correct environment is required.");
    if (config.environment === "production" && payment.provider === "payfast-sandbox") {
      try { await assertCourierTestCanCancel(reader, order, shipment); }
      catch { throw new WaybillChangeConflict("A matching verified payment in the correct environment is required."); }
      if (input.action === "prepare_replacement") throw new WaybillChangeConflict("The single live TEST waybill can be cancelled and archived, but cannot create a replacement booking.");
    }
    const jobs = await reader.select().from(bobgoOrderSync).where(and(eq(bobgoOrderSync.orderId, order.id), eq(bobgoOrderSync.environment, config.environment)));
    if (jobs.some(job => job.remoteOrderId || job.submittedAt || ["synced", "checking", "syncing"].includes(job.status)
      || job.leaseExpiresAt && job.leaseExpiresAt.getTime() > clock())) throw new WaybillChangeConflict("This order is linked to a Bob Go sales-channel order. Arrange its change in Bob Go; do not create a separate shipment.");
  }
  async function readCurrent(shipment: Shipment, order: Order) {
    const checkedAt = new Date(clock());
    const rows = shipmentList(await provider(`/shipments?${new URLSearchParams({ id: shipment.providerShipmentId!, limit: "2", offset: "0" })}`));
    const matches = rows.filter(row => String(row.id) === shipment.providerShipmentId);
    if (matches.length !== 1) throw new WaybillChangeConflict("Bob Go could not uniquely confirm this waybill. Nothing has been unlocked.");
    const remote = matches[0], verified = verifiedShipment(remote, shipment, order.orderNumber, clock());
    if (remote.collected_date || remote.delivered_date) throw new WaybillChangeConflict("This parcel has already been handed over. Arrange changes with Bob Go.");
    return { remote, verified, checkedAt };
  }
  async function change(orderNumber: string, value: unknown, changedBy: string) {
    const input = waybillChangeInput.parse(value);
    const [order] = await database.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
    const [shipment] = order ? await database.select().from(shipments).where(eq(shipments.orderId, order.id)).limit(1) : [];
    await validate(database, order, shipment, input);
    // validate() proves both exist; keep explicit narrowing for the compiler.
    if (!order || !shipment) throw new WaybillChangeConflict("Order not found.");
    let readback = await readCurrent(shipment, order);
    let expectedRevision = input.expectedRevision;
    if (input.action === "prepare_replacement" && readback.verified.status !== "cancelled") {
      throw new WaybillChangeConflict("Bob Go has not confirmed cancellation. Delivery details remain locked.");
    }
    if (input.action === "cancel_waybill" && readback.verified.status !== "cancelled") {
      const collectionKind = shipment.bookingSnapshot?.collection?.kind;
      // Unknown legacy collection mode gets the more restrictive pickup rule.
      const pickupCollection = collectionKind !== "door" || Boolean(readback.remote.collection_pickup_point_location_id);
      if (!canCancelProviderShipment(readback.remote, pickupCollection)) throw new WaybillChangeConflict("Bob Go cannot cancel this waybill at its current stage. Contact Bob Go before changing delivery.");
      const reservation = await database.transaction(async tx => {
        const [currentOrder] = await tx.select().from(orders).where(eq(orders.id, order.id)).for("update");
        const [current] = await tx.select().from(shipments).where(eq(shipments.id, shipment.id)).for("update");
        await validate(tx, currentOrder, current, input);
        if (current.providerShipmentId !== shipment.providerShipmentId) throw new WaybillChangeConflict("The waybill changed. Refresh the order.");
        if (current.courierCheckedAt && current.courierCheckedAt > readback.checkedAt) throw new WaybillChangeConflict("Shipment status changed while checking. Refresh before continuing.");
        const history = await tx.select().from(orderDeliveryHistory).where(eq(orderDeliveryHistory.orderId, order.id));
        if (cancellationRequested(history, current)) return { submit: false, revision: currentOrder.deliveryRevision };
        const revision = currentOrder.deliveryRevision + 1;
        await tx.insert(orderDeliveryHistory).values({ orderId: order.id, revision, action: "waybill_cancel_requested", changedBy,
          before: { shipment: current }, after: { provider: current.provider, providerShipmentId: current.providerShipmentId, trackingNumber: current.trackingNumber } });
        await tx.update(orders).set({ deliveryRevision: revision, updatedAt: new Date(clock()) }).where(eq(orders.id, order.id));
        return { submit: true, revision };
      });
      expectedRevision = reservation.revision;
      if (reservation.submit) {
        // Durable fence committed first. Even a timeout never triggers an
        // automatic second cancellation. A later action can only read status.
        await provider("/shipments/cancel", { tracking_reference: shipment.trackingNumber!, note: "Store owner requested a delivery change before parcel handover." });
      }
      readback = await readCurrent(shipment, order);
    }
    return database.transaction(async tx => {
      const [currentOrder] = await tx.select().from(orders).where(eq(orders.id, order.id)).for("update");
      const [current] = await tx.select().from(shipments).where(eq(shipments.id, shipment.id)).for("update");
      // The cancellation reservation increments the revision exactly once.
      await validate(tx, currentOrder, current, { ...input, expectedRevision });
      if (current.providerShipmentId !== shipment.providerShipmentId || current.provider !== shipment.provider) throw new WaybillChangeConflict("The waybill changed. Refresh the order.");
      if (current.courierCheckedAt && current.courierCheckedAt > readback.checkedAt) throw new WaybillChangeConflict("Shipment status changed while checking. Refresh before continuing.");
      if (input.action === "prepare_replacement") {
        const revision = currentOrder.deliveryRevision + 1;
        await tx.insert(orderDeliveryHistory).values({ orderId: order.id, revision, action: "waybill_replacement_prepared", changedBy,
          before: { shipment: current, courierPlan: currentOrder.courierPlan }, after: { previousTrackingNumber: current.trackingNumber, status: "not_ready" } });
        await tx.update(shipments).set({ status: "not_ready", providerShipmentId: null, waybillReference: null, trackingNumber: null, trackingUrl: null,
          serviceLevelCode: null, bookingSnapshot: null, bookedAt: null, courierStatus: null, courierStatusAt: null, courierCheckedAt: null,
          courierChargedAmount: null, weightGrams: null, lengthCm: null, widthCm: null, heightCm: null, lastError: null, updatedAt: new Date(clock()) }).where(eq(shipments.id, current.id));
        await tx.update(orders).set({ courierName: null, trackingNumber: null, trackingUrl: null, deliveryRevision: revision, updatedAt: new Date(clock()) }).where(eq(orders.id, order.id));
        return { message: "Previous waybill saved in history. Edit delivery details, confirm the packed parcel, then get fresh quotes and approve a replacement booking. The customer's order and payment are unchanged." };
      }
      const cancelled = readback.verified.status === "cancelled";
      // A delayed provider read must never resurrect a locally cancelled record.
      if (!cancelled && current.status === "cancelled") throw new WaybillChangeConflict("Bob Go has not confirmed final cancellation. Delivery details remain locked.");
      await tx.update(shipments).set({ ...(cancelled ? { status: "cancelled" as const } : {}), courierStatus: readback.verified.status || null,
        courierStatusAt: readback.verified.statusAt, courierCheckedAt: readback.checkedAt, updatedAt: new Date(clock()) }).where(eq(shipments.id, current.id));
      return { message: cancelled ? "Bob Go confirms this waybill is cancelled. Choose Prepare replacement delivery to edit and book again. No customer refund or replacement booking was made."
        : "Cancellation is not yet confirmed by Bob Go. Delivery remains locked. Check cancellation status again; do not book another waybill." };
    });
  }
  return { change };
}

export async function changeOrderWaybill(orderNumber: string, value: unknown, changedBy: string) {
  return createWaybillChanges(requireDatabase(), getBobGoConfiguration(), (path, body) => bobGoRequest(path, body, { operation: "courier_cancel" })).change(orderNumber, value, changedBy);
}
