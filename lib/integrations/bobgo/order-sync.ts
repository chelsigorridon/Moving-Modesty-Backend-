import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { requireDatabase } from "../../db";
import { addresses, bobgoOrderSync, customers, orderItems, orders, payments, productVariants, shipments, orderStatusHistory } from "../../db/schema";
import { readOrderCustomer } from "../../checkout-safety";
import { fingerprint, record, textValue } from "./protocol";
import { buildBobGoOrderPayload, getOrderSyncConfiguration, matchRemoteOrder, stableOrderPayload, OrderSyncInputError,
  type BobGoOrderPayload, type BobGoOrderSource, type OrderSyncConfiguration, type OrderSyncErrorCode } from "./order-sync-policy";
import { existingWaybillReference, verifiedExistingWaybill, WaybillLinkError, type WaybillLinkErrorCode } from "./waybill-link-policy";

type Database = ReturnType<typeof requireDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select" | "insert" | "update">;
type SyncRow = typeof bobgoOrderSync.$inferSelect;
const payloadFingerprint = (payload: BobGoOrderPayload | null) => fingerprint(stableOrderPayload(payload));

// The account/channel-bound HTTP adapter is separate. This service is also used
// with an isolated fake provider; it never reads API credentials itself.
export interface BobGoOrderSyncProvider {
  findOrders(orderNumber: string): Promise<unknown[]>;
  createOrder(payload: BobGoOrderPayload): Promise<unknown>;
  readShipment(id: string): Promise<unknown>;
  readOrderFulfillments(id: string): Promise<unknown>;
}

async function eligibleOrder(tx: Reader, orderId: string, config: OrderSyncConfiguration) {
  const [data] = await tx.select({ order: orders, payment: payments }).from(orders)
    .leftJoin(payments, eq(payments.orderId, orders.id)).where(eq(orders.id, orderId)).limit(1);
  if (!data || data.order.archivedAt || data.order.deliveryMethod !== "courier" || data.order.paymentStatus !== "paid"
    || ["cancelled", "collected"].includes(data.order.status) || data.payment?.status !== "paid" || !data.payment.verifiedAt
    || !data.payment.providerPaymentId || data.payment.provider !== `payfast-${config.environment}`
    || Number(data.order.total) !== Number(data.payment.amount)) return null;
  return data.order;
}

async function mayCreateOrder(tx: Reader, order: typeof orders.$inferSelect) {
  if (!["confirmed", "processing", "ready"].includes(order.status)) return false;
  const [shipment] = await tx.select({ status: shipments.status, providerShipmentId: shipments.providerShipmentId })
    .from(shipments).where(eq(shipments.orderId, order.id)).limit(1);
  return !shipment || (!["booking", "booked", "cancelled"].includes(shipment.status) && !shipment.providerShipmentId);
}

// Called inside PayFast's existing verified-payment transaction. The default
// gate returns before any new-table access, preserving today's live workflow.
export async function enqueuePaidBobGoOrder(tx: Reader, orderId: string, config = getOrderSyncConfiguration()) {
  if (!config.enabled) return { queued: false, reason: "disabled" };
  if (!config.channelRef || config.channelRef === "not-activated") throw new Error("Bob Go sync channel is not configured.");
  const order = await eligibleOrder(tx, orderId, config);
  if (!order || !(await mayCreateOrder(tx, order))) return { queued: false, reason: "ineligible" };
  await tx.insert(bobgoOrderSync).values({ orderId, environment: config.environment, channelRef: config.channelRef,
    deliveryRevision: order.deliveryRevision }).onConflictDoNothing({ target: [bobgoOrderSync.orderId, bobgoOrderSync.environment, bobgoOrderSync.channelRef] });
  return { queued: true };
}

async function sourceFor(tx: Reader, orderId: string): Promise<BobGoOrderSource> {
  const [data] = await tx.select({ order: orders, customer: customers, address: addresses }).from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id)).leftJoin(addresses, eq(orders.deliveryAddressId, addresses.id))
    .where(eq(orders.id, orderId)).limit(1);
  if (!data?.address || data.order.deliveryFee === null) throw new OrderSyncInputError("invalid_order");
  const customer = readOrderCustomer(data.order.customerSnapshot, data.customer || { firstName: "", lastName: "", email: "", phone: "" });
  const items = await tx.select({ sku: orderItems.sku, name: orderItems.productName, variant: orderItems.variantName,
    quantity: orderItems.quantity, unitPrice: orderItems.unitPrice, weightGrams: productVariants.shippingWeightGrams })
    .from(orderItems).leftJoin(productVariants, eq(orderItems.variantId, productVariants.id)).where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  const contact = data.order.courierPlan?.delivery.contact || { name: data.address.recipientName,
    email: customer.email, phone: customer.phone || "" };
  return { orderNumber: data.order.orderNumber, contact,
    address: { company: "", line1: data.address.line1, line2: data.address.line2 || "", suburb: data.address.suburb || "",
      city: data.address.city, province: data.address.province, postalCode: data.address.postalCode },
    subtotal: Number(data.order.subtotal), total: Number(data.order.total), deliveryFee: Number(data.order.deliveryFee), discountAmount: Number(data.order.discountAmount),
    items: items.map(item => ({ sku: item.sku, description: `${item.name} — ${item.variant}`, quantity: item.quantity,
      unitPrice: Number(item.unitPrice), weightGrams: item.weightGrams })) };
}

export function createBobGoOrderSyncService(database: Database, provider: BobGoOrderSyncProvider,
  config: OrderSyncConfiguration, clock: () => number = Date.now) {
  const scope = (orderId: string) => and(eq(bobgoOrderSync.orderId, orderId), eq(bobgoOrderSync.environment, config.environment), eq(bobgoOrderSync.channelRef, config.channelRef));
  const now = () => new Date(clock());
  async function lock(tx: Transaction, orderId: string) {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update");
    const [job] = await tx.select().from(bobgoOrderSync).where(scope(orderId)).for("update").limit(1);
    return job;
  }
  async function finish(orderId: string, lease: string, status: string, code: OrderSyncErrorCode | null, remoteOrderId?: string) {
    return database.transaction(async tx => {
      const job = await lock(tx, orderId);
      if (!job || job.leaseToken !== lease) return { status: "busy" };
      const order = await eligibleOrder(tx, orderId, config);
      if (!order) { status = "needs_attention"; code = "ineligible"; }
      if (status === "synced") {
        try { if (payloadFingerprint(buildBobGoOrderPayload(await sourceFor(tx, orderId))) !== payloadFingerprint(job.requestSnapshot)) { status = "needs_attention"; code = "delivery_changed"; } }
        catch { status = "needs_attention"; code = "delivery_changed"; }
      }
      const seconds = Math.min(1800, 30 * 2 ** Math.min(job.attempts, 6));
      await tx.update(bobgoOrderSync).set({ status, lastErrorCode: code, leaseToken: null, leaseExpiresAt: null,
        nextAttemptAt: new Date(clock() + seconds * 1000), ...(remoteOrderId ? { remoteOrderId } : {}),
        ...(status === "synced" ? { syncedAt: now(), deliveryRevision: order!.deliveryRevision } : {}), updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
      return { status };
    });
  }
  async function sync(orderId: string) {
    if (!config.enabled) return { status: "disabled" };
    const claimed = await database.transaction(async tx => {
      // Order lock is always taken first, matching checkout/delivery/booking.
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update");
      await enqueuePaidBobGoOrder(tx, orderId, config);
      const job = await lock(tx, orderId), order = await eligibleOrder(tx, orderId, config);
      if (!job || !order) {
        if (job) await tx.update(bobgoOrderSync).set({ status: "needs_attention", lastErrorCode: "ineligible", updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
        return { status: "ineligible" as const };
      }
      if (job.leaseToken && job.leaseExpiresAt && job.leaseExpiresAt.getTime() > clock()) return { status: "busy" as const };
      let payload: BobGoOrderPayload;
      try { payload = buildBobGoOrderPayload(await sourceFor(tx, orderId)); }
      catch (error) {
        await tx.update(bobgoOrderSync).set({ status: "needs_attention", lastErrorCode: error instanceof OrderSyncInputError ? error.code : "invalid_order", updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
        return { status: "needs_attention" as const };
      }
      if (job.requestSnapshot && payloadFingerprint(job.requestSnapshot) !== payloadFingerprint(payload) && (job.submittedAt || job.remoteOrderId)) {
        await tx.update(bobgoOrderSync).set({ status: "needs_attention", lastErrorCode: "delivery_changed", updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
        return { status: "needs_attention" as const };
      }
      if (job.status === "synced") return { status: "synced" as const };
      if (job.nextAttemptAt.getTime() > clock()) return { status: "waiting" as const };
      if (job.attempts >= 8) {
        await tx.update(bobgoOrderSync).set({ status: "needs_attention", updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
        return { status: "needs_attention" as const };
      }
      const lease = randomUUID();
      await tx.update(bobgoOrderSync).set({ status: "syncing", requestSnapshot: payload, attempts: job.attempts + 1,
        leaseToken: lease, leaseExpiresAt: new Date(clock() + 120000), updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
      return { status: "claimed" as const, job, payload, lease, orderNumber: order.orderNumber };
    });
    if (claimed.status !== "claimed") return { status: claimed.status };
    const { job, payload, lease, orderNumber } = claimed;
    let matches: unknown[];
    try { matches = await provider.findOrders(orderNumber); }
    catch { return finish(orderId, lease, "retry", "lookup_failed"); }
    if (!Array.isArray(matches)) return finish(orderId, lease, "needs_attention", "remote_mismatch");
    if (matches.length > 1) return finish(orderId, lease, "needs_attention", "duplicate_remote");
    if (matches.length === 1) {
      const id = matchRemoteOrder(matches[0], payload);
      return id ? finish(orderId, lease, "synced", null, id) : finish(orderId, lease, "needs_attention", "remote_mismatch");
    }
    // A timed-out POST can still have succeeded. An empty lookup is not proof
    // that it is safe to repeat it (eventual consistency/provider retries).
    if (job.submittedAt || job.remoteOrderId) return finish(orderId, lease, "checking", "create_unconfirmed");
    const stillEligible = await eligibleOrder(database, orderId, config);
    if (!stillEligible || !(await mayCreateOrder(database, stillEligible))) return finish(orderId, lease, "needs_attention", "shipment_exists");
    const approved = await database.transaction(async tx => {
      const current = await lock(tx, orderId);
      if (!current || current.leaseToken !== lease || !current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= clock()) return false;
      const order = await eligibleOrder(tx, orderId, config);
      if (!order || !(await mayCreateOrder(tx, order))) return false;
      try { if (payloadFingerprint(buildBobGoOrderPayload(await sourceFor(tx, orderId))) !== payloadFingerprint(payload)) return false; }
      catch { return false; }
      // Commit the unknown-outcome guard BEFORE any external write.
      await tx.update(bobgoOrderSync).set({ submittedAt: now(), updatedAt: now() }).where(eq(bobgoOrderSync.id, current.id));
      return true;
    });
    if (!approved) return finish(orderId, lease, "needs_attention", "delivery_changed");
    try {
      const result = await provider.createOrder(payload), id = matchRemoteOrder(result, payload);
      return id ? finish(orderId, lease, "synced", null, id) : finish(orderId, lease, "checking", "create_unconfirmed");
    } catch { return finish(orderId, lease, "checking", "create_unconfirmed"); }
  }

  // Future authenticated webhook handling must call this server-side read-back,
  // never apply caller-supplied shipment status directly. There is no public
  // webhook endpoint or live adapter in this review release.
  async function refreshTracking(orderId: string) {
    if (!config.enabled) return { status: "disabled" };
    const [shipment] = await database.select().from(shipments).where(eq(shipments.orderId, orderId)).limit(1);
    if (!shipment?.providerShipmentId || !shipment.trackingNumber || shipment.status !== "booked" || shipment.provider !== `bobgo-${config.environment}`) return { status: "ineligible" };
    const remote = record(await provider.readShipment(shipment.providerShipmentId));
    const allowed = ["pending-collection", "collected", "at-hub", "in-transit", "at-destination-hub", "out-for-delivery", "delivered", "delivery-exception", "cancelled"];
    const status = textValue(remote.status), timestamp = new Date(textValue(remote.tracking_last_event_time || remote.time_modified));
    if (textValue(remote.id) !== shipment.providerShipmentId || textValue(remote.tracking_reference) !== shipment.trackingNumber
      || (shipment.bookingSnapshot && remote.provider_slug !== shipment.bookingSnapshot.providerSlug)
      || !allowed.includes(status) || !Number.isFinite(timestamp.getTime()) || timestamp.getTime() > clock() + 300000) return { status: "needs_attention" };
    return database.transaction(async tx => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update");
      const [current] = await tx.select().from(shipments).where(eq(shipments.orderId, orderId)).for("update");
      if (!current || current.status !== "booked" || current.providerShipmentId !== shipment.providerShipmentId || current.trackingNumber !== shipment.trackingNumber
        || current.provider !== `bobgo-${config.environment}` || !(await eligibleOrder(tx, orderId, config))) return { status: "ineligible" };
      if ((current.courierStatusAt && current.courierStatusAt.getTime() >= timestamp.getTime()) || current.courierStatus === "delivered") return { status: "unchanged" };
      await tx.update(shipments).set({ courierStatus: status, courierStatusAt: timestamp, updatedAt: now() }).where(eq(shipments.id, current.id));
      // No payment, stock, internal fulfilment status or email writes here.
      return { status: "updated" };
    });
  }

  async function recordLinkCheck(orderId: string, remoteId: string, code?: WaybillLinkErrorCode | null) {
    return database.transaction(async tx => {
      const job = await lock(tx, orderId);
      if (!job || job.status !== "synced" || job.remoteOrderId !== remoteId) return;
      await tx.update(bobgoOrderSync).set({ waybillLinkCheckedAt: now(), ...(code !== undefined ? { waybillLinkErrorCode: code } : {}), updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
    });
  }

  // Read existing fulfilments only. This never creates/attaches/cancels anything
  // in Bob Go. It is behind the same hard-off gate as the prepared sync runner.
  async function refreshWaybillLink(orderId: string) {
    if (!config.enabled) return { status: "disabled" };
    const [job] = await database.select().from(bobgoOrderSync).where(scope(orderId)).limit(1);
    if (!job || job.status !== "synced" || !job.remoteOrderId) return { status: "ineligible" };
    // Reserve a check time before network access, including for now-ineligible
    // jobs, so an outage/cancelled order cannot starve later channel jobs.
    await recordLinkCheck(orderId, job.remoteOrderId);
    if (!job.requestSnapshot || !(await eligibleOrder(database, orderId, config))) return { status: "ineligible" };
    const remoteId = job.remoteOrderId, expected = job.requestSnapshot;
    try {
      if (payloadFingerprint(buildBobGoOrderPayload(await sourceFor(database, orderId))) !== payloadFingerprint(expected)) throw new WaybillLinkError("fulfillment_conflict");
      const matches = await provider.findOrders(expected.channel_order_number);
      if (matches.length !== 1 || matchRemoteOrder(matches[0], expected) !== remoteId) throw new WaybillLinkError();
      const reference = existingWaybillReference(await provider.readOrderFulfillments(remoteId), matches[0], expected);
      if (!reference) { await recordLinkCheck(orderId, remoteId, null); return { status: "not_booked" }; }
      const candidate = verifiedExistingWaybill(await provider.readShipment(reference.shipmentId), reference, expected, clock());
      const result = await database.transaction(async tx => {
        const currentJob = await lock(tx, orderId), order = await eligibleOrder(tx, orderId, config);
        if (!order || !currentJob || currentJob.status !== "synced" || currentJob.remoteOrderId !== remoteId
          || payloadFingerprint(currentJob.requestSnapshot) !== payloadFingerprint(expected)
          || payloadFingerprint(buildBobGoOrderPayload(await sourceFor(tx, orderId))) !== payloadFingerprint(expected)) throw new WaybillLinkError("fulfillment_conflict");
        const [current] = await tx.select().from(shipments).where(eq(shipments.orderId, orderId)).for("update");
        const plan = order.courierPlan;
        if ((order.trackingNumber && order.trackingNumber !== candidate.trackingNumber)
          || (current && (["cancelled"].includes(current.status)
          || (current.providerShipmentId && (current.provider !== `bobgo-${config.environment}` || current.providerShipmentId !== candidate.shipmentId))
          || (current.trackingNumber && current.trackingNumber !== candidate.trackingNumber)
          || (current.status === "booking" && !current.providerShipmentId)
          || (current.status === "booked" && !current.providerShipmentId)))
          || (current?.bookingSnapshot && (current.bookingSnapshot.providerSlug !== candidate.providerSlug || current.bookingSnapshot.serviceCode !== candidate.serviceCode))
          || (plan && (plan.collection.kind !== candidate.collectionKind || plan.delivery.kind !== candidate.deliveryKind))) throw new WaybillLinkError("fulfillment_conflict");
        const [other] = await tx.select({ orderId: shipments.orderId }).from(shipments)
          .where(and(eq(shipments.provider, `bobgo-${config.environment}`), eq(shipments.providerShipmentId, candidate.shipmentId))).limit(1);
        if (other && other.orderId !== orderId) throw new WaybillLinkError("fulfillment_conflict");
        const unchanged = current?.status === "booked" && current.providerShipmentId === candidate.shipmentId && current.trackingNumber === candidate.trackingNumber
          && order.trackingNumber === candidate.trackingNumber && order.trackingUrl === "https://track.bobgo.co.za/";
        if (!unchanged) {
          const values = { provider: `bobgo-${config.environment}`, status: "booked" as const, providerShipmentId: candidate.shipmentId,
            trackingNumber: candidate.trackingNumber, waybillReference: candidate.trackingNumber, trackingUrl: "https://track.bobgo.co.za/",
            serviceLevelCode: candidate.serviceCode, bookedAt: current?.bookedAt || candidate.bookedAt, lastError: null, updatedAt: now() };
          if (current) await tx.update(shipments).set(values).where(eq(shipments.id, current.id));
          else await tx.insert(shipments).values({ orderId, senderLocationName: "Booked in Bob Go", ...values });
          // Only tracking metadata changes. Never payment, stock, fulfilment or email.
          await tx.update(orders).set({ courierName: candidate.providerName, trackingNumber: candidate.trackingNumber,
            trackingUrl: "https://track.bobgo.co.za/", updatedAt: now() }).where(eq(orders.id, orderId));
          await tx.insert(orderStatusHistory).values({ orderId, fromStatus: order.status, toStatus: order.status,
            note: "Existing Bob Go waybill linked after verified order, full fulfilment and shipment read-back. No new shipment booked." });
        }
        await tx.update(bobgoOrderSync).set({ waybillLinkCheckedAt: now(), waybillLinkErrorCode: null, updatedAt: now() }).where(eq(bobgoOrderSync.id, currentJob.id));
        return { status: unchanged ? "unchanged" : "linked" };
      });
      return result;
    } catch (error) {
      // A uniqueness race rolls the whole link transaction back. No existing
      // waybill is overwritten, and raw provider/SQL errors are never persisted.
      const code = error instanceof WaybillLinkError ? error.code : "fulfillment_lookup_failed";
      await recordLinkCheck(orderId, remoteId, code);
      return { status: "needs_attention" };
    }
  }
  async function retry(orderId: string) {
    if (!config.enabled) return { status: "disabled" };
    return database.transaction(async tx => {
      const job = await lock(tx, orderId);
      if (!job || !(await eligibleOrder(tx, orderId, config))) return { status: "ineligible" };
      if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > clock()) return { status: "busy" };
      if (job.status === "synced") return { status: "synced" };
      // Preserve requestSnapshot, remoteOrderId and especially submittedAt.
      // A support retry after a timeout can reconcile, never authorise a duplicate.
      await tx.update(bobgoOrderSync).set({ status: job.submittedAt ? "checking" : "queued", attempts: 0,
        leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now(), updatedAt: now() }).where(eq(bobgoOrderSync.id, job.id));
      return { status: "queued" };
    });
  }
  return { sync, refreshTracking, refreshWaybillLink, retry };
}

export type BobGoOrderSyncRow = SyncRow;
