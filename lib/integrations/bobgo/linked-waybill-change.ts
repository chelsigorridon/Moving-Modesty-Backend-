import "server-only";
import { and, eq } from "drizzle-orm";
import type { requireDatabase } from "../../db";
import { bobgoOrderSync, orderDeliveryHistory, orders, payments, shipments } from "../../db/schema";
import type { OrderSyncConfiguration } from "./order-sync-policy";
import type { LinkedBookingProvider } from "./linked-booking-transport";
import { LinkedBookingConflict, expectedFingerprint, linkedBookingPaused, linkedOrderMatch } from "./linked-booking-policy";
import { activeLinkedFulfillments, linkedFulfillmentReference, retiredLinkedFulfillments, verifyRetiredShipments, type RetiredLinkedFulfillment } from "./linked-fulfillment-policy";
import { cancellationRequested, canCancelProviderShipment, handedOverStatuses, waybillChangeInput } from "./waybill-change-policy";
import { inspectLinkedBookingPermissions, linkedWaybillChangePermissions } from "./permissions";
import { record } from "./protocol";
import { verifiedExistingWaybill } from "./waybill-link-policy";
import { verifiedShipment } from "./tracking-policy";

type Database = ReturnType<typeof requireDatabase>;
type Reader = Pick<Database, "select" | "insert" | "update">;
type Input = ReturnType<typeof waybillChangeInput.parse>;
export function createLinkedWaybillChanges(database: Database, config: OrderSyncConfiguration,
  provider: Pick<LinkedBookingProvider, "readPermissions" | "readOrder" | "readOrderFulfillments" | "readShipment" | "cancelFulfillment">, clock = Date.now) {
  const now = () => new Date(clock());
  const scope = (id: string) => and(eq(bobgoOrderSync.orderId, id), eq(bobgoOrderSync.environment, config.environment), eq(bobgoOrderSync.channelRef, config.channelRef));
  async function load(reader: Reader, number: string, input: Input) {
    const [order] = await reader.select().from(orders).where(eq(orders.orderNumber, number)).limit(1);
    if (!order || order.archivedAt || order.deliveryMethod !== "courier" || order.paymentStatus !== "paid"
      || !["new", "confirmed", "processing", "ready"].includes(order.status)) throw new LinkedBookingConflict("Only active paid delivery orders that have not been handed over can change their linked waybill.");
    if (order.deliveryRevision !== input.expectedRevision) throw new LinkedBookingConflict("This order changed. Refresh it before continuing.");
    const [job] = await reader.select().from(bobgoOrderSync).where(scope(order.id)).limit(1);
    const jobs = await reader.select().from(bobgoOrderSync).where(and(eq(bobgoOrderSync.orderId, order.id), eq(bobgoOrderSync.environment, config.environment)));
    if (jobs.some(row => row.channelRef !== config.channelRef && (row.remoteOrderId || row.submittedAt || ["syncing", "checking", "synced"].includes(row.status)))) throw new LinkedBookingConflict();
    const [shipment] = await reader.select().from(shipments).where(eq(shipments.orderId, order.id)).limit(1);
    const link = shipment?.bookingSnapshot?.linkedOrder;
    const [payment] = await reader.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
    if (!job?.remoteOrderId || !job.requestSnapshot || job.status !== "synced" || !shipment?.providerShipmentId || !shipment.trackingNumber || !link
      || shipment.provider !== `bobgo-${config.environment}` || shipment.trackingNumber !== input.expectedWaybill
      || !["booking", "booked", "cancelled"].includes(shipment.status) || link.remoteOrderId !== job.remoteOrderId || link.channelRef !== config.channelRef
      || link.requestFingerprint !== expectedFingerprint(job.requestSnapshot)) throw new LinkedBookingConflict("The waybill could not be matched to this channel order. Check its linked booking before making changes.");
    if (handedOverStatuses.has(shipment.courierStatus || "")) throw new LinkedBookingConflict("This parcel has been handed over. Changes must be arranged through Bob Go.");
    if (payment?.status !== "paid" || payment.provider !== `payfast-${config.environment}` || !payment.verifiedAt || !payment.providerPaymentId
      || Number(payment.amount) !== Number(order.total)) throw new LinkedBookingConflict("A matching verified payment in the correct environment is required.");
    if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > clock()) throw new LinkedBookingConflict("This linked order is being checked in another session. Wait and refresh.");
    const history = await reader.select().from(orderDeliveryHistory).where(eq(orderDeliveryHistory.orderId, order.id));
    const retired = retiredLinkedFulfillments(history, { environment: config.environment, channelRef: config.channelRef, remoteOrderId: job.remoteOrderId });
    return { order, shipment, job, history, retired };
  }
  type State = Awaited<ReturnType<typeof load>>;
  async function lock(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], id: string) {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).for("update");
    await tx.select({ id: bobgoOrderSync.id }).from(bobgoOrderSync).where(scope(id)).for("update");
    await tx.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, id)).for("update");
  }
  async function readCurrent(state: State) {
    const checkedAt = now(), expected = state.job.requestSnapshot!, snapshot = state.shipment.bookingSnapshot!;
    const remote = record(await provider.readOrder(state.job.remoteOrderId!));
    if (linkedOrderMatch(remote, expected, snapshot) !== state.job.remoteOrderId || remote.status === "cancelled") throw new LinkedBookingConflict();
    await verifyRetiredShipments(state.retired, provider.readShipment);
    const active = activeLinkedFulfillments(await provider.readOrderFulfillments(state.job.remoteOrderId!), { ...remote, delivery_address: expected.delivery_address }, expected, state.retired);
    const reference = linkedFulfillmentReference(active, { ...remote, delivery_address: expected.delivery_address }, expected, true);
    if (reference.shipmentId !== state.shipment.providerShipmentId || reference.trackingNumber !== state.shipment.trackingNumber) throw new LinkedBookingConflict("Bob Go reports a different or additional linked waybill. Nothing has been unlocked.");
    const raw = record(await provider.readShipment(reference.shipmentId));
    verifiedExistingWaybill(raw, reference, expected, clock(), true);
    const verified = verifiedShipment(raw, state.shipment, state.order.orderNumber, clock());
    if (state.shipment.courierStatusAt && verified.statusAt < state.shipment.courierStatusAt) throw new LinkedBookingConflict("Bob Go returned older tracking information. Delivery remains locked until a fresh status is confirmed.");
    if (state.shipment.bookingSnapshot?.linkedOrder?.cancellationConfirmed && (!reference.cancelled || verified.status !== "cancelled")) throw new LinkedBookingConflict("A previously confirmed cancellation now conflicts with Bob Go. Delivery remains locked.");
    if (raw.collected_date || raw.delivered_date || handedOverStatuses.has(verified.status)) throw new LinkedBookingConflict("Courier tracking reports this parcel has been handed over. Delivery remains locked.");
    const cancelled = reference.cancelled && verified.status === "cancelled";
    const quantitiesReleased = Array.isArray(remote.order_items) && remote.order_items.every(item => [0, "0"].includes(record(item).fulfilled_qty as number | string));
    return { checkedAt, reference, raw, verified, cancelled, quantitiesReleased };
  }
  function sameWaybill(current: State, previous: State, checkedAt: Date) {
    if (current.job.remoteOrderId !== previous.job.remoteOrderId || current.shipment.providerShipmentId !== previous.shipment.providerShipmentId
      || current.shipment.trackingNumber !== previous.shipment.trackingNumber || current.shipment.provider !== previous.shipment.provider
      || (current.shipment.courierCheckedAt && current.shipment.courierCheckedAt > checkedAt)) throw new LinkedBookingConflict("The waybill or tracking state changed while checking. Refresh before continuing.");
  }
  async function change(number: string, value: unknown, changedBy: string) {
    if (!config.enabled) throw new LinkedBookingConflict(linkedBookingPaused);
    const input = waybillChangeInput.parse(value), state = await load(database, number, input);
    if (!inspectLinkedBookingPermissions(await provider.readPermissions(), linkedWaybillChangePermissions).allowed) throw new LinkedBookingConflict("Bob Go has not confirmed the API permissions for linked cancellation. No cancellation was requested.");
    let readback = await readCurrent(state), revision = input.expectedRevision;
    if (input.action === "cancel_waybill" && !readback.cancelled && !readback.reference.cancelled && readback.verified.status !== "cancelled") {
      if (!canCancelProviderShipment(readback.raw, state.shipment.bookingSnapshot!.collection.kind !== "door" || Boolean(readback.raw.collection_pickup_point_location_id))) throw new LinkedBookingConflict("This courier booking is no longer eligible for cancellation. No replacement was allowed.");
      const reservation = await database.transaction(async tx => {
        await lock(tx, state.order.id); const current = await load(tx, number, input); sameWaybill(current, state, readback.checkedAt);
        if (cancellationRequested(current.history, current.shipment)) return { submit: false, revision: current.order.deliveryRevision };
        const next = current.order.deliveryRevision + 1;
        await tx.insert(orderDeliveryHistory).values({ orderId: state.order.id, revision: next, action: "waybill_cancel_requested", changedBy,
          before: { shipment: current.shipment }, after: { provider: current.shipment.provider, providerShipmentId: current.shipment.providerShipmentId,
            trackingNumber: current.shipment.trackingNumber, fulfillmentId: readback.reference.fulfillmentId, remoteOrderId: state.job.remoteOrderId, channelRef: config.channelRef } });
        await tx.update(orders).set({ deliveryRevision: next, updatedAt: now() }).where(eq(orders.id, state.order.id));
        return { submit: true, revision: next };
      });
      revision = reservation.revision;
      if (reservation.submit) {
        try { await provider.cancelFulfillment(readback.reference.fulfillmentId); }
        catch { throw new LinkedBookingConflict("Linked cancellation is not confirmed. Do not repeat it or book another waybill. Use Check cancellation status; the original booking remains locked."); }
      }
      readback = await readCurrent(state);
    }
    return database.transaction(async tx => {
      await lock(tx, state.order.id); const current = await load(tx, number, { ...input, expectedRevision: revision }); sameWaybill(current, state, readback.checkedAt);
      if (input.action === "prepare_replacement") {
        if (!readback.cancelled || !readback.quantitiesReleased) throw new LinkedBookingConflict("Bob Go must confirm both the shipment and fulfilment cancelled, with the order quantities released, before replacement delivery is unlocked.");
        const next = current.order.deliveryRevision + 1;
        const proof: RetiredLinkedFulfillment = { environment: config.environment, channelRef: config.channelRef, remoteOrderId: state.job.remoteOrderId!,
          fulfillmentId: readback.reference.fulfillmentId, shipmentId: readback.reference.shipmentId, trackingNumber: readback.reference.trackingNumber };
        const confirmedShipment = { ...current.shipment, status: "cancelled" as const, courierStatus: "cancelled", bookingSnapshot: { ...current.shipment.bookingSnapshot!,
          linkedOrder: { ...current.shipment.bookingSnapshot!.linkedOrder!, cancellationConfirmed: true } } };
        await tx.insert(orderDeliveryHistory).values({ orderId: state.order.id, revision: next, action: "waybill_replacement_prepared", changedBy,
          before: { shipment: confirmedShipment, courierPlan: current.order.courierPlan }, after: { previousTrackingNumber: current.shipment.trackingNumber, status: "not_ready", linkedCancellation: proof } });
        await tx.update(shipments).set({ status: "not_ready", providerShipmentId: null, waybillReference: null, trackingNumber: null, trackingUrl: null,
          serviceLevelCode: null, bookingSnapshot: null, bookedAt: null, courierStatus: null, courierStatusAt: null, courierCheckedAt: null,
          courierChargedAmount: null, weightGrams: null, lengthCm: null, widthCm: null, heightCm: null, lastError: null, updatedAt: now() }).where(eq(shipments.id, current.shipment.id));
        await tx.update(orders).set({ courierName: null, trackingNumber: null, trackingUrl: null, deliveryRevision: next, updatedAt: now() }).where(eq(orders.id, state.order.id));
        await tx.update(bobgoOrderSync).set({ deliveryRevision: next, waybillLinkErrorCode: null, waybillLinkCheckedAt: now(), updatedAt: now() }).where(eq(bobgoOrderSync.id, current.job.id));
        return { message: "Cancelled waybill kept in history. Edit delivery details, confirm the packed parcel and compare fresh quotes. A replacement requires separate cost approval and stays linked to the same Bob Go order. The customer's payment is unchanged." };
      }
      const confirmed = readback.cancelled && readback.quantitiesReleased;
      await tx.update(shipments).set({ ...(confirmed ? { status: "cancelled" as const } : {}), courierStatus: readback.verified.status,
        courierStatusAt: readback.verified.statusAt, courierCheckedAt: readback.checkedAt,
        bookingSnapshot: { ...current.shipment.bookingSnapshot!, linkedOrder: { ...current.shipment.bookingSnapshot!.linkedOrder!, cancellationConfirmed: confirmed } },
        lastError: confirmed ? null : "Linked cancellation is not fully confirmed. Check cancellation status; delivery remains locked.", updatedAt: now() }).where(eq(shipments.id, current.shipment.id));
      return { message: confirmed ? "Bob Go confirms the shipment and fulfilment cancelled. Prepare replacement delivery to change details and compare fresh quotes. No replacement booking or customer refund was made."
        : "Bob Go has not confirmed the full linked cancellation. Delivery remains locked. Check cancellation status; do not book another waybill." };
    });
  }
  return { change };
}
