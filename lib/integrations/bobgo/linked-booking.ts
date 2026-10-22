import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { requireDatabase } from "../../db";
import { bobgoOrderSync, orders, payments, shipments, orderStatusHistory, orderDeliveryHistory } from "../../db/schema";
import { reconcileExistingBobGoOrder, sourceFor } from "./order-sync";
import { buildBobGoOrderPayload, type OrderSyncConfiguration } from "./order-sync-policy";
import { resolveCourierPlan } from "./delivery";
import { inspectLinkedBookingPermissions } from "./permissions";
import { existingWaybillReference, verifiedExistingWaybill } from "./waybill-link-policy";
import { assertNoFulfillments, collectionBookId, expectedFingerprint, linkedFulfillmentPayload, linkedOrderMatch, linkedOrderUpdate,
  linkedBookingPaused, LinkedBookingConflict, linkedStandardCoverMatches, remoteBookingFingerprint } from "./linked-booking-policy";
import type { LinkedBookingProvider } from "./linked-booking-transport";
import { fingerprint, parcelInput, parseRates, record, signQuote, textValue, verifyQuote, type CourierBookingSnapshot, type PackedParcel } from "./protocol";
import { bobGoAddressesMatch, normalizeBobGoText } from "./address-policy";
import { courierContactInput } from "../../delivery-input";
import { activeLinkedFulfillments, retiredLinkedFulfillments, retiredFingerprint, verifyRetiredShipments } from "./linked-fulfillment-policy";
import { linkedCollectionDateMatches, linkedCollectionInstructions, linkedCollectionProblem, linkedCollectionShipmentMatches } from "./linked-collection";
import { isOrderInSyncScope } from "./activation-policy";

type Database = ReturnType<typeof requireDatabase>;
type Reader = Pick<Database, "select" | "insert" | "update">;

// Dependency-injected so every external action can be tested offline. This
// service cannot create orders and never calls the standalone shipment endpoint.
export function createLinkedBookingService(database: Database, provider: LinkedBookingProvider,
  config: OrderSyncConfiguration, secret: string, clock = Date.now) {
  const scope = (id: string) => and(eq(bobgoOrderSync.orderId, id), eq(bobgoOrderSync.environment, config.environment), eq(bobgoOrderSync.channelRef, config.channelRef));
  const now = () => new Date(clock());
  function enabled() { if (!config.enabled || !secret || !config.channelRef || config.channelRef === "not-activated") throw new LinkedBookingConflict(linkedBookingPaused); }
  async function load(reader: Reader, number: string) {
    const [order] = await reader.select().from(orders).where(eq(orders.orderNumber, number)).limit(1);
    if (!order || !isOrderInSyncScope(order, config)) throw new LinkedBookingConflict("Linked booking is enabled for new orders only. This older order is unchanged.");
    const [job] = await reader.select().from(bobgoOrderSync).where(scope(order.id)).limit(1);
    const otherChannels = await reader.select().from(bobgoOrderSync).where(and(eq(bobgoOrderSync.orderId, order.id), eq(bobgoOrderSync.environment, config.environment)));
    if (otherChannels.some(row => row.channelRef !== config.channelRef && (row.remoteOrderId || row.submittedAt || ["syncing", "checking", "synced"].includes(row.status)))) throw new LinkedBookingConflict("This order also has another channel submission. Reconcile both copies before booking.");
    const [shipment] = await reader.select().from(shipments).where(eq(shipments.orderId, order.id)).limit(1);
    const [payment] = await reader.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
    if (order.archivedAt || order.deliveryMethod !== "courier" || order.status !== "ready" || order.paymentStatus !== "paid"
      || payment?.status !== "paid" || payment.provider !== `payfast-${config.environment}` || !payment.verifiedAt || !payment.providerPaymentId
      || Number(payment.amount) !== Number(order.total) || !order.courierPlan || order.inventoryIssue
      || !job?.remoteOrderId || !job.requestSnapshot || !(job.status === "synced" || job.status === "needs_attention" && job.lastErrorCode === "delivery_changed")) {
      throw new LinkedBookingConflict("A verified paid Ready order, saved delivery setup and confirmed Bob Go channel order are required.");
    }
    const history = await reader.select().from(orderDeliveryHistory).where(eq(orderDeliveryHistory.orderId, order.id));
    const retired = retiredLinkedFulfillments(history, { environment: config.environment, channelRef: config.channelRef, remoteOrderId: job.remoteOrderId });
    const previous = history.filter(row => row.action === "waybill_replacement_prepared" && record(row.after).linkedCancellation).sort((a, b) => b.revision - a.revision)[0];
    const previousSnapshot = record(record(previous?.before).shipment).bookingSnapshot as CourierBookingSnapshot | undefined;
    return { order, job, shipment, retired, previousSnapshot, expected: buildBobGoOrderPayload(await sourceFor(reader, order.id)) };
  }
  type State = Awaited<ReturnType<typeof load>>;
  function canStart(state: State) {
    if (state.shipment && (["booking", "booked", "cancelled"].includes(state.shipment.status) || state.shipment.providerShipmentId)) throw new LinkedBookingConflict("A shipment already exists or may be processing. Check its linked waybill; do not book another.");
    if (state.job.leaseExpiresAt && state.job.leaseExpiresAt.getTime() > clock()) throw new LinkedBookingConflict("This linked order is being checked in another session. Wait and refresh.");
  }
  function assertCurrentSchedule(state: State) {
    const problem = linkedCollectionProblem(state.order.courierPlan!, clock());
    if (problem) throw new LinkedBookingConflict(problem);
    // Validate the complete driver note before any remote order update.
    try { linkedCollectionInstructions(state.order.courierPlan!.collectionInstructions, state.order.courierPlan!.collectionSchedule); }
    catch (error) { throw new LinkedBookingConflict(error instanceof Error ? error.message : "Check the collection instructions."); }
  }
  function localFingerprint(state: State, parcel: PackedParcel) {
    return fingerprint({ expected: expectedFingerprint(state.expected), revision: state.order.deliveryRevision, plan: state.order.courierPlan,
      remoteId: state.job.remoteOrderId, channel: config.channelRef, environment: config.environment, parcel, retired: retiredFingerprint(state.retired) });
  }
  function assertSavedParcel(state: State, parcel: PackedParcel) {
    const shipment = state.shipment;
    const saved = parcelInput.safeParse({ weightGrams: shipment?.weightGrams, lengthCm: Number(shipment?.lengthCm), widthCm: Number(shipment?.widthCm), heightCm: Number(shipment?.heightCm) });
    if (!saved.success || fingerprint(saved.data) !== fingerprint(parcel)) throw new LinkedBookingConflict("Packed measurements changed. Compare couriers again.");
  }
  async function lock(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], id: string) {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).for("update");
    await tx.select({ id: bobgoOrderSync.id }).from(bobgoOrderSync).where(scope(id)).for("update");
    await tx.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, id)).for("update");
  }
  async function permissions() {
    if (!inspectLinkedBookingPermissions(await provider.readPermissions()).allowed) throw new LinkedBookingConflict("Bob Go has not confirmed all required API permissions for linked booking. No waybill was requested.");
  }
  async function readActive(state: State, remote: unknown, expected = state.expected) {
    await verifyRetiredShipments(state.retired, provider.readShipment);
    return activeLinkedFulfillments(await provider.readOrderFulfillments(state.job.remoteOrderId!),
      { ...record(remote), delivery_address: expected.delivery_address }, expected, state.retired);
  }
  async function quotes(number: string, value: unknown, additionalCover: boolean) {
    enabled(); const parcel = parcelInput.parse(value);
    if (additionalCover) throw new LinkedBookingConflict("Additional parcel cover is not enabled for linked bookings.");
    const [candidate] = await database.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, number)).limit(1);
    if (candidate) await reconcileExistingBobGoOrder(database, provider, config, candidate.id, clock);
    const initial = await load(database, number), lease = randomUUID();
    assertCurrentSchedule(initial);
    const state = await database.transaction(async tx => {
      await lock(tx, initial.order.id); const current = await load(tx, number); canStart(current); assertCurrentSchedule(current);
      await tx.update(bobgoOrderSync).set({ leaseToken: lease, leaseExpiresAt: new Date(clock() + 120000), updatedAt: now() }).where(eq(bobgoOrderSync.id, current.job.id));
      return current;
    });
    try {
      await permissions();
      const before = record(await provider.readOrder(state.job.remoteOrderId!));
      const route = state.order.courierPlan ? { delivery: { ...state.order.courierPlan.delivery, address: state.expected.delivery_address } } as Pick<CourierBookingSnapshot, "delivery"> : undefined;
      const priorMatches = linkedOrderMatch(before, state.job.requestSnapshot!, route) === state.job.remoteOrderId
        || Boolean(state.previousSnapshot && linkedOrderMatch(before, state.job.requestSnapshot!, state.previousSnapshot) === state.job.remoteOrderId);
      if (!(priorMatches || linkedOrderMatch(before, state.expected, route) === state.job.remoteOrderId)
        || before.status === "cancelled" || before.status === "completed" && !state.retired.length
        || !Array.isArray(before.order_items) || before.order_items.some(item => Number(record(item).fulfilled_qty || 0) !== 0)) throw new LinkedBookingConflict();
      assertNoFulfillments(await readActive(state, before, priorMatches ? state.job.requestSnapshot! : state.expected));
      const resolved = await resolveCourierPlan(state.order.courierPlan!, parcel);
      const snapshot: CourierBookingSnapshot = { collection: resolved.collection, delivery: resolved.delivery,
        collectionInstructions: linkedCollectionInstructions(resolved.plan.collectionInstructions, resolved.plan.collectionSchedule), deliveryInstructions: resolved.plan.deliveryInstructions,
        ...(resolved.collection.kind === "door" ? { collectionSchedule: resolved.plan.collectionSchedule, collectionTimeMode: "preferred_instructions" as const } : {}),
        providerSlug: "", providerName: "", serviceCode: "", serviceName: "", amount: 0 };
      const bookId = collectionBookId(await provider.readCollections(), snapshot.collection);
      // Do not send order_items, payment_status or order totals. PATCHing an
      // order's item array replaces it and would break remote item identities.
      await provider.updateOrder(linkedOrderUpdate(state.job.remoteOrderId!, state.expected, snapshot, parcel, bookId));
      let remote = record(await provider.readOrder(state.job.remoteOrderId!));
      const update = linkedOrderUpdate(state.job.remoteOrderId!, state.expected, snapshot, parcel, bookId);
      const presets = record(remote.order_fulfillment_presets);
      const actualParcels = Array.isArray(presets.parcels) ? presets.parcels.map(value => {
        const row = record(value); return [Number(row.submitted_length_cm), Number(row.submitted_width_cm), Number(row.submitted_height_cm), Number(row.submitted_weight_kg)];
      }) : [];
      if (linkedOrderMatch(remote, state.expected, snapshot) !== state.job.remoteOrderId || presets.method !== "shipment"
        || textValue(presets.collection_address_book_id) !== bookId || !linkedStandardCoverMatches(presets)
        || !linkedCollectionDateMatches(presets.requested_collection_date, snapshot.collectionSchedule)
        || resolved.collection.kind === "pickup_point" && textValue(presets.requested_collection_date) !== ""
        || textValue(presets.instructions_collection) !== snapshot.collectionInstructions || textValue(presets.instructions_delivery) !== snapshot.deliveryInstructions
        || fingerprint(actualParcels) !== fingerprint([[parcel.lengthCm, parcel.widthCm, parcel.heightCm, parcel.weightGrams / 1000]])) {
        throw new LinkedBookingConflict("Bob Go did not confirm the saved address and packed parcel. No waybill was requested.");
      }
      const remoteHash = remoteBookingFingerprint(remote);
      let response: unknown = await provider.orderRates({ order_id: update.id, queue_rates: true, new_rates_modal: true });
      let rates: ReturnType<typeof parseRates> = [], requestId = 0, pending = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const order = record(record(response).order || response), request = record(order.rate_request);
        if (String(order.id) !== state.job.remoteOrderId) throw new LinkedBookingConflict();
        requestId = Number(request.id ?? request.rate_request_id);
        if (!Number.isSafeInteger(requestId) || requestId <= 0) throw new LinkedBookingConflict("Bob Go did not return an order-specific quote reference.");
        rates = parseRates(request, resolved.providerSlug);
        pending = Array.isArray(request.provider_rate_requests) && request.provider_rate_requests.some(value => ["pending", "queued", "processing", "pending-rates"].includes(textValue(record(value).status)));
        if (rates.length && !pending) break;
        if (attempt < 3) response = await provider.orderRates({ order_id: update.id, rate_request_id: requestId, new_rates_modal: true });
      }
      if (!rates.length || pending) throw new LinkedBookingConflict("Bob Go has not finished returning the eligible linked-order courier quotes. Wait briefly and compare again; no waybill was requested.");
      // A concurrent Bob Go dashboard edit/booking invalidates these quotes.
      remote = record(await provider.readOrder(state.job.remoteOrderId!));
      if (remoteBookingFingerprint(remote) !== remoteHash) throw new LinkedBookingConflict("The Bob Go order changed while comparing couriers. Get a fresh quote.");
      assertNoFulfillments(await readActive(state, remote));
      snapshot.linkedOrder = { remoteOrderId: state.job.remoteOrderId!, channelRef: config.channelRef, requestFingerprint: expectedFingerprint(state.expected),
        remoteFingerprint: remoteHash, collectionAddressBookId: bookId, retiredFingerprint: retiredFingerprint(state.retired) };
      await database.transaction(async tx => {
        await lock(tx, state.order.id); const current = await load(tx, number); assertCurrentSchedule(current);
        if (current.job.leaseToken !== lease || !current.job.leaseExpiresAt || current.job.leaseExpiresAt.getTime() <= clock()
          || localFingerprint(current, parcel) !== localFingerprint(state, parcel)) throw new LinkedBookingConflict("Delivery changed while comparing couriers. Get a new quote.");
        if (current.shipment && (["booking", "booked", "cancelled"].includes(current.shipment.status) || current.shipment.providerShipmentId)) throw new LinkedBookingConflict();
        const values = { provider: `bobgo-${config.environment}`, status: "ready_to_book" as const, weightGrams: parcel.weightGrams,
          lengthCm: parcel.lengthCm.toFixed(2), widthCm: parcel.widthCm.toFixed(2), heightCm: parcel.heightCm.toFixed(2), bookingSnapshot: snapshot,
          senderLocationName: snapshot.collection.point?.name || snapshot.collection.contact.name, pickupPointLocationId: snapshot.collection.point?.id || null, lastError: null, updatedAt: now() };
        await tx.insert(shipments).values({ orderId: state.order.id, ...values }).onConflictDoUpdate({ target: shipments.orderId, set: values });
        await tx.update(bobgoOrderSync).set({ status: "synced", lastErrorCode: null, requestSnapshot: state.expected,
          deliveryRevision: state.order.deliveryRevision, leaseToken: null, leaseExpiresAt: null, waybillLinkErrorCode: null, updatedAt: now() }).where(eq(bobgoOrderSync.id, state.job.id));
      });
      const expires = clock() + 10 * 60000;
      return { environment: config.environment, expires, declaredValue: 0, rates: rates.map(rate => ({ ...rate, quoteToken: signQuote({ ...rate,
        version: 3, rateRequestId: requestId, orderNumber: number, fingerprint: localFingerprint(state, parcel), expires, environment: config.environment,
        parcel, collectionAddress: snapshot.collection.address, declaredValue: 0, deliverySnapshot: { ...snapshot, ...rate, rateRequestId: requestId } }, secret) })) };
    } finally {
      await database.update(bobgoOrderSync).set({ leaseToken: null, leaseExpiresAt: null, updatedAt: now() })
        .where(and(eq(bobgoOrderSync.id, state.job.id), eq(bobgoOrderSync.leaseToken, lease)));
    }
  }
  async function book(number: string, token: string) {
    enabled(); const quote = verifyQuote(token, secret, clock()), linked = quote.deliverySnapshot?.linkedOrder;
    const state = await load(database, number); canStart(state);
    assertCurrentSchedule(state);
    assertSavedParcel(state, quote.parcel);
    if (quote.version !== 3 || !linked || quote.orderNumber !== number || quote.environment !== config.environment || linked.channelRef !== config.channelRef
      || linked.remoteOrderId !== state.job.remoteOrderId || linked.requestFingerprint !== expectedFingerprint(state.expected)
      || localFingerprint(state, quote.parcel) !== quote.fingerprint || state.shipment?.bookingSnapshot?.linkedOrder?.remoteFingerprint !== linked.remoteFingerprint
      || fingerprint(quote.deliverySnapshot?.collectionSchedule || null) !== fingerprint(state.order.courierPlan?.collectionSchedule || null)
      || quote.deliverySnapshot?.collectionInstructions !== linkedCollectionInstructions(state.order.courierPlan!.collectionInstructions, state.order.courierPlan!.collectionSchedule)) throw new LinkedBookingConflict("The order, parcel or linked quote changed. Compare couriers again.");
    await permissions();
    if (collectionBookId(await provider.readCollections(), quote.deliverySnapshot!.collection) !== linked.collectionAddressBookId) throw new LinkedBookingConflict("The saved Bob Go collection address changed. Get a fresh quote.");
    const remote = await provider.readOrder(linked.remoteOrderId);
    if (remoteBookingFingerprint(remote) !== linked.remoteFingerprint) throw new LinkedBookingConflict("The Bob Go order changed. Get a fresh quote.");
    assertNoFulfillments(await readActive(state, remote));
    const reference = `MM${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await database.transaction(async tx => {
      await lock(tx, state.order.id); const current = await load(tx, number); canStart(current); assertCurrentSchedule(current);
      assertSavedParcel(current, quote.parcel);
      if (quote.expires <= clock()) throw new LinkedBookingConflict("The courier quote expired. Get a new quote.");
      if (!current.shipment || localFingerprint(current, quote.parcel) !== quote.fingerprint
        || current.shipment.bookingSnapshot?.linkedOrder?.remoteFingerprint !== linked.remoteFingerprint) throw new LinkedBookingConflict();
      // Durable unknown-outcome fence BEFORE the chargeable POST. Neither an
      // HTTP failure nor an empty read-back unlocks or auto-retries a booking.
      await tx.update(shipments).set({ status: "booking", waybillReference: reference, serviceLevelCode: quote.serviceCode,
        bookingSnapshot: quote.deliverySnapshot!, lastError: "Linked booking submitted. Check its existing waybill before any retry.", updatedAt: now() }).where(eq(shipments.id, current.shipment.id));
      await tx.insert(orderStatusHistory).values({ orderId: state.order.id, fromStatus: current.order.status, toStatus: current.order.status,
        note: `Linked Bob Go booking approved for remote order ${linked.remoteOrderId}: ${quote.providerName} ${quote.serviceCode}, quoted R${quote.amount.toFixed(2)}, reference ${reference}.` });
    });
    try {
      await provider.createFulfillment(linkedFulfillmentPayload(quote, reference));
      return await reconcile(number);
    } catch {
      throw new LinkedBookingConflict("Bob Go has not confirmed this linked booking. Do not book again. Use Check shipment status to reconcile the existing order and waybill.");
    }
  }
  async function reconcile(number: string) {
    enabled(); const state = await load(database, number), local = state.shipment, linked = local?.bookingSnapshot?.linkedOrder;
    if (!linked || !local || !["booking", "booked"].includes(local.status) || linked.remoteOrderId !== state.job.remoteOrderId
      || linked.channelRef !== config.channelRef) throw new LinkedBookingConflict();
    const remote = await provider.readOrder(linked.remoteOrderId);
    if (linkedOrderMatch(remote, state.expected, local.bookingSnapshot!) !== linked.remoteOrderId) throw new LinkedBookingConflict();
    const reference = existingWaybillReference(await readActive(state, remote),
      { ...record(remote), delivery_address: state.expected.delivery_address }, state.expected);
    if (!reference) return { booked: false, message: "Linked booking is still unconfirmed. No new booking was requested. Check again later." };
    const raw = record(await provider.readShipment(reference.shipmentId));
    const candidate = verifiedExistingWaybill(raw, reference, state.expected, clock());
    const snapshot = local.bookingSnapshot!;
    if (raw.custom_tracking_reference !== local.waybillReference && local.status !== "booked"
      || candidate.providerSlug !== snapshot.providerSlug || candidate.serviceCode !== snapshot.serviceCode
      || candidate.collectionKind !== snapshot.collection.kind || candidate.deliveryKind !== snapshot.delivery.kind
      || !bobGoAddressesMatch(record(raw.collection_address), snapshot.collection.address)
      || normalizeBobGoText([raw.collection_contact_name, raw.collection_contact_surname].filter(Boolean).join(" ")) !== normalizeBobGoText(snapshot.collection.contact.name)
      || normalizeBobGoText(raw.collection_contact_email) !== normalizeBobGoText(snapshot.collection.contact.email)
      || courierContactInput.shape.phone.safeParse(raw.collection_contact_mobile_number).data !== snapshot.collection.contact.phone
      || (snapshot.collection.point && String(raw.collection_pickup_point_location_id) !== snapshot.collection.point.id)
      || (snapshot.delivery.point && String(raw.delivery_pickup_point_location_id) !== snapshot.delivery.point.id)) throw new LinkedBookingConflict();
    if (!linkedCollectionShipmentMatches(raw, snapshot.collectionSchedule, snapshot.collectionInstructions)) throw new LinkedBookingConflict("The existing waybill's collection date or driver instructions have not been confirmed. Check this waybill; do not book again.");
    await database.transaction(async tx => {
      await lock(tx, state.order.id); const current = await load(tx, number), shipment = current.shipment;
      if (!shipment || !["booking", "booked"].includes(shipment.status) || shipment.waybillReference !== local.waybillReference
        || expectedFingerprint(current.expected) !== linked.requestFingerprint || current.job.remoteOrderId !== linked.remoteOrderId
        || (shipment.providerShipmentId && shipment.providerShipmentId !== candidate.shipmentId)
        || (shipment.trackingNumber && shipment.trackingNumber !== candidate.trackingNumber)) throw new LinkedBookingConflict();
      await tx.update(shipments).set({ status: "booked", providerShipmentId: candidate.shipmentId, trackingNumber: candidate.trackingNumber,
        waybillReference: candidate.trackingNumber, trackingUrl: "https://track.bobgo.co.za/", bookedAt: shipment.bookedAt || candidate.bookedAt,
        lastError: null, updatedAt: now() }).where(eq(shipments.id, shipment.id));
      await tx.update(orders).set({ courierName: candidate.providerName, trackingNumber: candidate.trackingNumber,
        trackingUrl: "https://track.bobgo.co.za/", updatedAt: now() }).where(eq(orders.id, state.order.id));
      await tx.update(bobgoOrderSync).set({ waybillLinkErrorCode: null, waybillLinkCheckedAt: now(), updatedAt: now() }).where(eq(bobgoOrderSync.id, current.job.id));
    });
    return { booked: true, message: "Waybill booked against the existing Bob Go channel order. The same waybill is available in both systems." };
  }
  return { quotes, book, reconcile };
}
