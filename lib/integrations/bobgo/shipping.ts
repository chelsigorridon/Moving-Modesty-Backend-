import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns } from "drizzle-orm";
import { checkoutOrderSchema } from "../../checkout-input";
import { readOrderCustomer } from "../../checkout-safety";
import { requireDatabase } from "../../db";
import { addresses, bobgoOrderSync, customers, orders, payments, shipments, orderStatusHistory } from "../../db/schema";
import { getBobGoConfiguration } from "./configuration";
import { resolveCourierPlan, deliveryRatePayload, deliveryShipmentPayload } from "./delivery";
import { bobGoRequest, getConfiguredBobGoLocation } from "./client";
import { reportFailure, resolveFailures } from "../../monitoring";
import { contactName, fingerprint, parcelInput, parcelPayload, parseLocation, parseRates, rateRequestId, record, records, signQuote, submissionIsBooked, textValue, verifyQuote, type ApprovedQuote, type PackedParcel } from "./protocol";
import { createDirectShipmentTracking } from "./tracking";
import { assertCourierTestCanQuote, assertCourierTestBookingApproval, reserveCourierTestAttempt } from "../../live-courier-test";

export class ShippingConflict extends Error {}
const database = () => requireDatabase();
const shippingOrderColumns = getTableColumns(orders);
function secret() {
  if (!process.env.AUTH_SECRET) throw new Error("Courier quote signing is not configured.");
  return process.env.AUTH_SECRET;
}
async function loadOrder(orderNumber: string) {
  const [data] = await database().select({ order: shippingOrderColumns, customer: customers, address: addresses, shipment: shipments,
    paymentProvider: payments.provider, paymentVerifiedAt: payments.verifiedAt, paymentReference: payments.providerPaymentId,
    paymentAmount: payments.amount, verifiedPaymentStatus: payments.status })
    .from(orders).leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(addresses, eq(orders.deliveryAddressId, addresses.id)).leftJoin(shipments, eq(shipments.orderId, orders.id))
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!data) throw new ShippingConflict("Order not found.");
  if (data.customer) Object.assign(data.customer, readOrderCustomer(data.order.customerSnapshot, data.customer));
  return data;
}
type ShippingOrder = Awaited<ReturnType<typeof loadOrder>>;
async function assertIndependentBookingAllowed(reader: Pick<ReturnType<typeof requireDatabase>, "select">, orderId: string) {
  // Also protects previously-synced orders if automatic sync is later paused.
  // Current unsynced orders retain the existing manual portal workflow.
  const jobs = await reader.select({ status: bobgoOrderSync.status, remoteId: bobgoOrderSync.remoteOrderId, submittedAt: bobgoOrderSync.submittedAt,
    leaseExpiresAt: bobgoOrderSync.leaseExpiresAt }).from(bobgoOrderSync)
    .where(and(eq(bobgoOrderSync.orderId, orderId), eq(bobgoOrderSync.environment, getBobGoConfiguration().environment)));
  if (jobs.some(job => job.remoteId || job.submittedAt || ["synced", "checking", "syncing"].includes(job.status) || (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > Date.now()))) {
    throw new ShippingConflict("This order is linked to Bob Go or its submission is still being checked. Book against the existing order in Bob Go, then check its linked waybill. Do not create a separate shipment.");
  }
}
async function assertCanBook(data: ShippingOrder, reader: Pick<ReturnType<typeof requireDatabase>, "select"> = database()) {
  const config = getBobGoConfiguration();
  if (!config.enabled || !config.apiTokenConfigured || (!data.order.courierPlan &&
    (!config.pickupPointLocationId || !config.pickupPointProviderSlug || !config.senderEmail || !config.senderPhone))) throw new ShippingConflict("Bob Go setup is incomplete or booking is disabled.");
  if (config.environment === "production" && data.paymentProvider === "payfast-sandbox") {
    try { await assertCourierTestCanQuote(reader, data.order); }
    catch { throw new ShippingConflict("Test payments cannot create live courier bookings. Only the separately authorised owner TEST can compare live quotes."); }
  }
  if (data.order.deliveryMethod !== "courier" || data.order.paymentStatus !== "paid" || data.order.status !== "ready") throw new ShippingConflict("Only paid delivery orders marked ready for courier can be booked.");
  if (data.order.archivedAt || data.verifiedPaymentStatus !== "paid" || !data.paymentVerifiedAt || !data.paymentReference
    || Number(data.paymentAmount) !== Number(data.order.total)) throw new ShippingConflict("A verified payment matching this active order is required before courier booking.");
  const address = data.address;
  if (!address?.line1 || !address.city || !address.province || !address.postalCode || address.countryCode !== "ZA" || !data.customer?.phone || !data.customer.email) throw new ShippingConflict("A complete South African address, customer email and phone number are required.");
  const addressCheck = checkoutOrderSchema.safeParse({ checkoutToken: data.order.checkoutToken, stage: "complete",
    customer: data.customer, fulfilmentMethod: "delivery", address: { ...address, line2: address.line2 ?? "" },
    items: [{ sku: "VALIDATION-ONLY", quantity: 1 }] });
  if (!addressCheck.success) throw new ShippingConflict(addressCheck.error.issues[0]?.message ?? "Check the delivery address before booking.");
  if (data.shipment && (data.shipment.status === "booking" || data.shipment.status === "booked" || data.shipment.status === "cancelled" || data.shipment.providerShipmentId)) throw new ShippingConflict("A shipment already exists or may still be processing. Check its status; do not book another waybill.");
}
function orderFingerprint(data: ShippingOrder, parcel: PackedParcel) {
  const config = getBobGoConfiguration();
  return fingerprint({ order: data.order, address: data.address, customer: data.customer, parcel,
    environment: config.environment, pickupPoint: config.pickupPointLocationId, provider: config.pickupPointProviderSlug,
    sender: [config.senderName, config.senderEmail, config.senderPhone] });
}
function shipmentParcel(data: ShippingOrder): PackedParcel {
  return parcelInput.parse({ weightGrams: data.shipment?.weightGrams, lengthCm: Number(data.shipment?.lengthCm), widthCm: Number(data.shipment?.widthCm), heightCm: Number(data.shipment?.heightCm) });
}
function deliveryAddress(data: ShippingOrder) {
  const address = data.address!;
  return { type: "residential", company: "", street_address: [address.line1, address.line2].filter(Boolean).join(", "),
    local_area: address.suburb || "", city: address.city, zone: address.province, country: address.countryCode, code: address.postalCode };
}
export async function getCourierQuotes(orderNumber: string, input: unknown, additionalCover: boolean) {
  const parcel = parcelInput.parse(input);
  let data = await loadOrder(orderNumber);
  await assertCanBook(data);
  await assertIndependentBookingAllowed(database(), data.order.id);
  const requestedFingerprint = orderFingerprint(data, parcel);
  const config = getBobGoConfiguration();
  const resolved = data.order.courierPlan ? await resolveCourierPlan(data.order.courierPlan, parcel, { operation: "courier_quote", orderId: data.order.id }) : null;
  const location = resolved ? { address: resolved.collection.address, name: resolved.collection.point?.name || resolved.collection.contact.name }
    : parseLocation(await getConfiguredBobGoLocation(parcel, { operation: "courier_quote", orderId: data.order.id }), config.pickupPointLocationId!, config.pickupPointProviderSlug!);
  const declaredValue = additionalCover ? Number(data.order.subtotal) : 0;
  const response = await bobGoRequest("/rates", resolved ? deliveryRatePayload(resolved, parcel, orderNumber, declaredValue) : {
    collection_address: location.address, delivery_address: deliveryAddress(data),
    collection_contact_full_name: config.senderName, collection_contact_email: config.senderEmail,
    collection_contact_mobile_number: config.senderPhone,
    delivery_contact_full_name: data.address!.recipientName, delivery_contact_email: data.customer!.email,
    delivery_contact_mobile_number: data.customer!.phone,
    parcels: parcelPayload(parcel, orderNumber), declared_value: declaredValue, timeout: 25000,
    collection_pickup_point_location_id: Number(config.pickupPointLocationId),
    pickup_point_provider_slug: config.pickupPointProviderSlug, providers: [config.pickupPointProviderSlug],
  }, { operation: "courier_quote", orderId: data.order.id });
  const rates = parseRates(response, resolved ? resolved.providerSlug : config.pickupPointProviderSlug!);
  if (!rates.length) {
    await reportFailure(null, { operation: "courier_quote", orderId: data.order.id, code: "provider_request" });
    const reasons = records(record(response).provider_rate_requests).flatMap(provider => [provider.failed_reason,
      ...records(provider.responses).map(rate => rate.failed_reason)]).map(textValue).filter(Boolean);
    throw new ShippingConflict(`No available courier quote for this delivery setup. ${reasons.join(" ").slice(0, 500) || "Check the delivery address, parcel size and Bob Go account."}${additionalCover ? " If additional declared-value cover is unsupported, review the courier's standard cover before choosing a quote without it." : ""}`);
  }
  // This is the quote's reference, not a Bob Go sales-channel order ID.
  const selectedRateRequestId = rateRequestId(response);
  // Persist measurements only if no other session has started booking in the meantime.
  await database().transaction(async transaction => {
    const [locked] = await transaction.select(shippingOrderColumns).from(orders).where(eq(orders.id, data.order.id)).for("update");
    const [shipment] = await transaction.select().from(shipments).where(eq(shipments.orderId, locked.id)).for("update");
    await assertIndependentBookingAllowed(transaction, locked.id);
    await assertCanBook({ ...data, order: locked, shipment: shipment || null }, transaction);
    if (fingerprint(locked) !== fingerprint(data.order)) throw new ShippingConflict("The order changed. Refresh it and get a new quote.");
    const values = { provider: `bobgo-${config.environment}`, weightGrams: parcel.weightGrams, lengthCm: parcel.lengthCm.toFixed(2), widthCm: parcel.widthCm.toFixed(2), heightCm: parcel.heightCm.toFixed(2),
      pickupPointLocationId: resolved ? resolved.collection.point?.id || null : config.pickupPointLocationId,
      senderLocationName: resolved ? location.name : config.senderLocationName, status: "ready_to_book" as const, lastError: null, updatedAt: new Date() };
    await transaction.insert(shipments).values({ orderId: locked.id, ...values }).onConflictDoUpdate({ target: shipments.orderId, set: values });
  });
  data = await loadOrder(orderNumber);
  await assertCanBook(data);
  const savedParcel = shipmentParcel(data);
  if (fingerprint(savedParcel) !== fingerprint(parcel)) throw new ShippingConflict("Parcel details changed in another session. Get a new quote.");
  // Never pair rates/route snapshots from an earlier order with a newer order's
  // signature, including an edit committed just after measurement persistence.
  if (orderFingerprint(data, savedParcel) !== requestedFingerprint) throw new ShippingConflict("The order changed. Refresh it and get a new quote.");
  const expires = Date.now() + 10 * 60_000;
  return { environment: config.environment, expires, declaredValue, rates: rates.map(rate => ({ ...rate,
    quoteToken: signQuote({ ...rate, version: resolved ? 2 : 1, rateRequestId: selectedRateRequestId, orderNumber, fingerprint: orderFingerprint(data, savedParcel), expires,
      environment: config.environment, parcel: savedParcel, collectionAddress: location.address, declaredValue,
      ...(resolved ? { deliverySnapshot: { collection: resolved.collection, delivery: resolved.delivery,
        collectionInstructions: resolved.plan.collectionInstructions, deliveryInstructions: resolved.plan.deliveryInstructions, rateRequestId: selectedRateRequestId, ...rate } } : {}) }, secret()) })) };
}
export async function bookCourierShipment(orderNumber: string, quoteToken: string, testCostApproval = "") {
  let quote: ApprovedQuote;
  try { quote = verifyQuote(quoteToken, secret()); }
  catch (error) { throw new ShippingConflict(error instanceof Error ? error.message : "Get a fresh courier quote."); }
  if (!Number.isSafeInteger(quote.rateRequestId) || Number(quote.rateRequestId) <= 0) throw new ShippingConflict("Get a fresh courier quote before booking.");
  const data = await loadOrder(orderNumber);
  await assertCanBook(data);
  const liveTest = quote.environment === "production" && data.paymentProvider === "payfast-sandbox";
  if (liveTest) {
    try { await assertCourierTestBookingApproval(database(), data.order, quoteToken, testCostApproval); }
    catch (error) { throw new ShippingConflict(error instanceof Error ? error.message : "Approve the exact real TEST courier cost first."); }
  }
  if (quote.orderNumber !== orderNumber || quote.environment !== getBobGoConfiguration().environment || quote.fingerprint !== orderFingerprint(data, shipmentParcel(data))) throw new ShippingConflict("Order or parcel details changed. Get a new courier quote.");
  const attemptReference = `MM${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await database().transaction(async transaction => {
    const [locked] = await transaction.select(shippingOrderColumns).from(orders).where(eq(orders.id, data.order.id)).for("update");
    const [shipment] = await transaction.select().from(shipments).where(eq(shipments.orderId, locked.id)).for("update");
    const current = { ...data, order: locked, shipment: shipment || null };
    await assertCanBook(current, transaction);
    await assertIndependentBookingAllowed(transaction, locked.id);
    if (quote.fingerprint !== orderFingerprint(current, shipmentParcel(current))) throw new ShippingConflict("Order or parcel details changed. Get a new courier quote.");
    if (liveTest) await reserveCourierTestAttempt(transaction, locked, quoteToken, testCostApproval, attemptReference);
    // Commit a durable lock BEFORE the chargeable POST. Never release it on an unknown outcome.
    await transaction.update(shipments).set({ provider: `bobgo-${quote.environment}`, status: "booking", waybillReference: attemptReference,
      serviceLevelCode: quote.serviceCode, bookingSnapshot: quote.deliverySnapshot ? { ...quote.deliverySnapshot, ...(liveTest ? { testAttemptReference: attemptReference } : {}) } : null,
      lastError: "Booking submitted. If the response is delayed, check Bob Go before any retry.", updatedAt: new Date() }).where(eq(shipments.orderId, locked.id));
    await transaction.insert(orderStatusHistory).values({ orderId: locked.id, fromStatus: locked.status, toStatus: locked.status,
      note: `Manual Bob Go booking approved: ${quote.providerName} ${quote.serviceCode}, quoted R${quote.amount.toFixed(2)}, declared value R${quote.declaredValue.toFixed(2)}, reference ${attemptReference}.` });
  });
  const config = getBobGoConfiguration();
  const sender = contactName(config.senderName), recipient = contactName(data.address!.recipientName);
  const body = quote.deliverySnapshot ? deliveryShipmentPayload(quote.deliverySnapshot, quote.parcel, orderNumber, attemptReference, quote.declaredValue) : {
    collection_address: quote.collectionAddress, collection_contact_name: sender.name, collection_contact_surname: sender.surname,
    collection_contact_email: config.senderEmail, collection_contact_mobile_number: config.senderPhone,
    delivery_address: deliveryAddress(data), delivery_contact_name: recipient.name, delivery_contact_surname: recipient.surname,
    delivery_contact_email: data.customer!.email, delivery_contact_mobile_number: data.customer!.phone,
    parcels: parcelPayload(quote.parcel, orderNumber), declared_value: quote.declaredValue, timeout: 20000,
    custom_tracking_reference: attemptReference, custom_order_number: orderNumber,
    instructions_collection: "Merchant drops off at the configured Bob Box locker. Deliver to the customer's door.",
    instructions_delivery: data.order.deliveryNotes || "", provider_slug: quote.providerSlug,
    service_level_code: quote.serviceCode, collection_pickup_point_location_id: Number(config.pickupPointLocationId),
  };
  Object.assign(body, { selected_rate_request_id: quote.rateRequestId });
  let result: unknown;
  try { result = await bobGoRequest("/shipments", body, { operation: "courier_book", orderId: data.order.id }); }
  catch (error) {
    // Includes validation/network/timeouts. A POST may have reached the provider even if we did not receive it.
    throw Object.assign(new ShippingConflict(`Bob Go did not confirm the booking. Do not book again. Check Bob Go for ${orderNumber} / ${attemptReference}, then use Check shipment status. Contact your website administrator if it is not found.`), { errorRef: error && typeof error === "object" && "errorRef" in error ? error.errorRef : undefined });
  }
  const booked = await saveShipmentResponse(data.order.id, result, attemptReference);
  return { booked, message: booked
    ? "Waybill booked. Download it and hand over the parcel using the booked collection method, then mark dispatched."
    : "Bob Go has not confirmed successful booking yet. Check shipment status; do not create another waybill." };
}
async function saveShipmentResponse(orderId: string, value: unknown, fallback: string) {
  const result = record(value);
  const tracking = textValue(result.tracking_reference);
  // The official tracker asks for the waybill number; do not invent a deep-link format.
  const trackingUrl = tracking ? "https://track.bobgo.co.za/" : null;
  const booked = await database().transaction(async transaction => {
    await transaction.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update");
    const [current] = await transaction.select().from(shipments).where(eq(shipments.orderId, orderId)).for("update");
    const snapshot = current?.bookingSnapshot;
    const booked = submissionIsBooked(value, snapshot ? { collection: snapshot.collection.kind, delivery: snapshot.delivery.kind } : undefined);
    if (current?.status === "booked" && !booked) throw new ShippingConflict("A confirmed waybill already exists. Check it directly in Bob Go before changing its status.");
    await transaction.update(shipments).set({ status: booked ? "booked" : "booking", providerShipmentId: textValue(result.id) || null,
      waybillReference: tracking || fallback, trackingNumber: tracking || null, trackingUrl,
      bookedAt: booked ? current?.bookedAt || new Date() : null,
      lastError: booked ? null : `Bob Go submission: ${textValue(result.submission_status) || "unconfirmed"}. ${textValue(result.failed_reason)} Check Bob Go before attempting another booking.`, updatedAt: new Date() }).where(eq(shipments.orderId, orderId));
    if (booked) await transaction.update(orders).set({ courierName: snapshot?.providerName || "Bob Go", trackingNumber: tracking, trackingUrl, updatedAt: new Date() }).where(eq(orders.id, orderId));
    return booked;
  });
  if (booked) await resolveFailures("courier_book", orderId);
  else if (textValue(result.failed_reason)) await reportFailure(null, { operation: "courier_book", orderId, code: "provider_request" });
  return booked;
}
function assertShipmentEnvironment(shipment: ShippingOrder["shipment"]) {
  const config = getBobGoConfiguration();
  if (!config.enabled || shipment?.provider !== `bobgo-${config.environment}`) throw new ShippingConflict("This shipment cannot be checked in the current Bob Go environment. Contact your website administrator.");
}
export async function refreshCourierShipment(orderNumber: string) {
  const data = await loadOrder(orderNumber);
  const shipment = data.shipment;
  if (!shipment || !["booking", "booked"].includes(shipment.status)) throw new ShippingConflict("There is no submitted shipment to check.");
  assertShipmentEnvironment(shipment);
  try {
    return await createDirectShipmentTracking(database(), getBobGoConfiguration().environment,
      path => bobGoRequest(path, undefined, { operation: "courier_refresh", orderId: data.order.id })).refresh(shipment.id);
  } catch (error) {
    if (error instanceof Error && error.name === "ShipmentReadbackError") throw new ShippingConflict(error.message);
    throw error;
  }
}
export async function getCourierWaybill(orderNumber: string) {
  const { shipment, order } = await loadOrder(orderNumber);
  if (shipment?.status !== "booked" || !shipment.trackingNumber) throw new ShippingConflict("A successfully booked shipment is required before printing a waybill.");
  assertShipmentEnvironment(shipment);
  const query = new URLSearchParams({ tracking_references: JSON.stringify([shipment.trackingNumber]) });
  const result = record(await bobGoRequest(`/shipments/waybill?${query}`, undefined, { operation: "courier_waybill", orderId: order.id }));
  const url = textValue(result.download_url);
  if (result.waybills_ready !== true || !url.startsWith("https://")) throw new ShippingConflict("Bob Go is still preparing the waybill. Try Download waybill again shortly.");
  return { url };
}
