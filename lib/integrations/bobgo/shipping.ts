import "server-only";
import { randomUUID } from "node:crypto";
import { eq, getTableColumns } from "drizzle-orm";
import { checkoutOrderSchema } from "../../checkout-input";
import { readOrderCustomer } from "../../checkout-safety";
import { requireDatabase } from "../../db";
import { addresses, customers, orders, payments, shipments, orderStatusHistory } from "../../db/schema";
import { getBobGoConfiguration } from "./configuration";
import { bobGoRequest, getConfiguredBobGoLocation } from "./client";
import { reportFailure, resolveFailures } from "../../monitoring";
import { fingerprint, parcelInput, parcelPayload, parseLocation, parseRates, record, records, signQuote, submissionIsBooked, textValue, verifyQuote, type ApprovedQuote, type PackedParcel } from "./protocol";

export class ShippingConflict extends Error {}
const database = () => requireDatabase();
const shippingOrderColumns = getTableColumns(orders);
function secret() {
  if (!process.env.AUTH_SECRET) throw new Error("Courier quote signing is not configured.");
  return process.env.AUTH_SECRET;
}
async function loadOrder(orderNumber: string) {
  const [data] = await database().select({ order: shippingOrderColumns, customer: customers, address: addresses, shipment: shipments, paymentProvider: payments.provider })
    .from(orders).leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(addresses, eq(orders.deliveryAddressId, addresses.id)).leftJoin(shipments, eq(shipments.orderId, orders.id))
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!data) throw new ShippingConflict("Order not found.");
  if (data.customer) Object.assign(data.customer, readOrderCustomer(data.order.customerSnapshot, data.customer));
  return data;
}
type ShippingOrder = Awaited<ReturnType<typeof loadOrder>>;
function assertCanBook(data: ShippingOrder) {
  const config = getBobGoConfiguration();
  if (!config.enabled || !config.apiTokenConfigured || !config.pickupPointLocationId || !config.pickupPointProviderSlug || !config.senderEmail || !config.senderPhone) throw new ShippingConflict("Bob Go setup is incomplete or booking is disabled.");
  if (config.environment === "production" && data.paymentProvider === "payfast-sandbox") throw new ShippingConflict("Test payments cannot create live courier bookings. Use a sandbox courier account for test orders.");
  if (data.order.deliveryMethod !== "courier" || data.order.paymentStatus !== "paid" || data.order.status !== "ready") throw new ShippingConflict("Only paid delivery orders marked ready for courier can be booked.");
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
  return { company: "", street_address: [address.line1, address.line2].filter(Boolean).join(", "),
    local_area: address.suburb || "", city: address.city, zone: address.province, country: address.countryCode, code: address.postalCode };
}
export async function getCourierQuotes(orderNumber: string, input: unknown, additionalCover: boolean) {
  const parcel = parcelInput.parse(input);
  let data = await loadOrder(orderNumber);
  assertCanBook(data);
  const config = getBobGoConfiguration();
  const location = parseLocation(await getConfiguredBobGoLocation(parcel, { operation: "courier_quote", orderId: data.order.id }), config.pickupPointLocationId!, config.pickupPointProviderSlug!);
  const declaredValue = additionalCover ? Number(data.order.subtotal) : 0;
  const response = await bobGoRequest("/rates", {
    collection_address: location.address, delivery_address: deliveryAddress(data),
    collection_contact_full_name: config.senderName, collection_contact_email: config.senderEmail,
    collection_contact_mobile_number: config.senderPhone,
    delivery_contact_full_name: data.address!.recipientName, delivery_contact_email: data.customer!.email,
    delivery_contact_mobile_number: data.customer!.phone,
    parcels: parcelPayload(parcel, orderNumber), declared_value: declaredValue, timeout: 10000,
    collection_pickup_point_location_id: Number(config.pickupPointLocationId),
    pickup_point_provider_slug: config.pickupPointProviderSlug, providers: [config.pickupPointProviderSlug],
  }, { operation: "courier_quote", orderId: data.order.id });
  const rates = parseRates(response, config.pickupPointProviderSlug!);
  if (!rates.length) {
    await reportFailure(null, { operation: "courier_quote", orderId: data.order.id, code: "provider_request" });
    const reasons = records(record(response).provider_rate_requests).flatMap(provider => [provider.failed_reason,
      ...records(provider.responses).map(rate => rate.failed_reason)]).map(textValue).filter(Boolean);
    throw new ShippingConflict(`No available locker-to-door courier quote. ${reasons.join(" ").slice(0, 500) || "Check the delivery address, parcel size and Bob Go account."}${additionalCover ? " If additional declared-value cover is unsupported, review the courier's standard cover before choosing a quote without it." : ""}`);
  }
  // Persist measurements only if no other session has started booking in the meantime.
  await database().transaction(async transaction => {
    const [locked] = await transaction.select(shippingOrderColumns).from(orders).where(eq(orders.id, data.order.id)).for("update");
    const [shipment] = await transaction.select().from(shipments).where(eq(shipments.orderId, locked.id)).for("update");
    assertCanBook({ ...data, order: locked, shipment: shipment || null });
    if (fingerprint(locked) !== fingerprint(data.order)) throw new ShippingConflict("The order changed. Refresh it and get a new quote.");
    const values = { provider: `bobgo-${config.environment}`, weightGrams: parcel.weightGrams, lengthCm: parcel.lengthCm.toFixed(2), widthCm: parcel.widthCm.toFixed(2), heightCm: parcel.heightCm.toFixed(2),
      pickupPointLocationId: config.pickupPointLocationId, senderLocationName: config.senderLocationName, status: "ready_to_book" as const, lastError: null, updatedAt: new Date() };
    await transaction.insert(shipments).values({ orderId: locked.id, ...values }).onConflictDoUpdate({ target: shipments.orderId, set: values });
  });
  data = await loadOrder(orderNumber);
  const savedParcel = shipmentParcel(data);
  if (fingerprint(savedParcel) !== fingerprint(parcel)) throw new ShippingConflict("Parcel details changed in another session. Get a new quote.");
  const expires = Date.now() + 10 * 60_000;
  return { environment: config.environment, expires, declaredValue, rates: rates.map(rate => ({ ...rate,
    quoteToken: signQuote({ ...rate, version: 1, orderNumber, fingerprint: orderFingerprint(data, savedParcel), expires,
      environment: config.environment, parcel: savedParcel, collectionAddress: location.address, declaredValue }, secret()) })) };
}
export async function bookCourierShipment(orderNumber: string, quoteToken: string) {
  let quote: ApprovedQuote;
  try { quote = verifyQuote(quoteToken, secret()); }
  catch (error) { throw new ShippingConflict(error instanceof Error ? error.message : "Get a fresh courier quote."); }
  const data = await loadOrder(orderNumber);
  assertCanBook(data);
  if (quote.orderNumber !== orderNumber || quote.environment !== getBobGoConfiguration().environment || quote.fingerprint !== orderFingerprint(data, shipmentParcel(data))) throw new ShippingConflict("Order or parcel details changed. Get a new courier quote.");
  const attemptReference = `MM${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await database().transaction(async transaction => {
    const [locked] = await transaction.select(shippingOrderColumns).from(orders).where(eq(orders.id, data.order.id)).for("update");
    const [shipment] = await transaction.select().from(shipments).where(eq(shipments.orderId, locked.id)).for("update");
    const current = { ...data, order: locked, shipment: shipment || null };
    assertCanBook(current);
    if (quote.fingerprint !== orderFingerprint(current, shipmentParcel(current))) throw new ShippingConflict("Order or parcel details changed. Get a new courier quote.");
    // Commit a durable lock BEFORE the chargeable POST. Never release it on an unknown outcome.
    await transaction.update(shipments).set({ provider: `bobgo-${quote.environment}`, status: "booking", waybillReference: attemptReference, serviceLevelCode: quote.serviceCode, lastError: "Booking submitted. If the response is delayed, check Bob Go before any retry.", updatedAt: new Date() }).where(eq(shipments.orderId, locked.id));
    await transaction.insert(orderStatusHistory).values({ orderId: locked.id, fromStatus: locked.status, toStatus: locked.status,
      note: `Manual Bob Go booking approved: ${quote.providerName} ${quote.serviceCode}, quoted R${quote.amount.toFixed(2)}, declared value R${quote.declaredValue.toFixed(2)}, reference ${attemptReference}.` });
  });
  const config = getBobGoConfiguration();
  const body = {
    collection_address: quote.collectionAddress, collection_contact_name: config.senderName,
    collection_contact_email: config.senderEmail, collection_contact_mobile_number: config.senderPhone,
    delivery_address: deliveryAddress(data), delivery_contact_name: data.address!.recipientName,
    delivery_contact_email: data.customer!.email, delivery_contact_mobile_number: data.customer!.phone,
    parcels: parcelPayload(quote.parcel, orderNumber), declared_value: quote.declaredValue, timeout: 20000,
    custom_tracking_reference: attemptReference, custom_order_number: orderNumber,
    instructions_collection: "Merchant drops off at the configured Bob Box locker. Deliver to the customer's door.",
    instructions_delivery: data.order.deliveryNotes || "", provider_slug: quote.providerSlug,
    service_level_code: quote.serviceCode, collection_pickup_point_location_id: Number(config.pickupPointLocationId),
  };
  let result: unknown;
  try { result = await bobGoRequest("/shipments", body, { operation: "courier_book", orderId: data.order.id }); }
  catch (error) {
    // Includes validation/network/timeouts. A POST may have reached the provider even if we did not receive it.
    throw Object.assign(new ShippingConflict(`Bob Go did not confirm the booking. Do not book again. Check Bob Go for ${orderNumber} / ${attemptReference}, then use Check shipment status. Contact your website administrator if it is not found.`), { errorRef: error && typeof error === "object" && "errorRef" in error ? error.errorRef : undefined });
  }
  await saveShipmentResponse(data.order.id, result, attemptReference);
  return { booked: submissionIsBooked(result), message: submissionIsBooked(result)
    ? "Waybill booked. Download it, drop off the parcel, then mark dispatched."
    : "Bob Go has not confirmed successful booking yet. Check shipment status; do not create another waybill." };
}
async function saveShipmentResponse(orderId: string, value: unknown, fallback: string) {
  const result = record(value);
  const booked = submissionIsBooked(value);
  const tracking = textValue(result.tracking_reference);
  // The official tracker asks for the waybill number; do not invent a deep-link format.
  const trackingUrl = tracking ? "https://track.bobgo.co.za/" : null;
  await database().transaction(async transaction => {
    await transaction.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update");
    const [current] = await transaction.select().from(shipments).where(eq(shipments.orderId, orderId)).for("update");
    if (current?.status === "booked" && !booked) throw new ShippingConflict("A confirmed waybill already exists. Check it directly in Bob Go before changing its status.");
    await transaction.update(shipments).set({ status: booked ? "booked" : "booking", providerShipmentId: textValue(result.id) || null,
      waybillReference: tracking || fallback, trackingNumber: tracking || null, trackingUrl,
      bookedAt: booked ? current?.bookedAt || new Date() : null,
      lastError: booked ? null : `Bob Go submission: ${textValue(result.submission_status) || "unconfirmed"}. ${textValue(result.failed_reason)} Check Bob Go before attempting another booking.`, updatedAt: new Date() }).where(eq(shipments.orderId, orderId));
    if (booked) await transaction.update(orders).set({ courierName: "Bob Go", trackingNumber: tracking, trackingUrl, updatedAt: new Date() }).where(eq(orders.id, orderId));
  });
  if (booked) await resolveFailures("courier_book", orderId);
  else if (textValue(result.failed_reason)) await reportFailure(null, { operation: "courier_book", orderId, code: "provider_request" });
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
  const response = shipment.providerShipmentId
    ? await bobGoRequest(`/shipments?${new URLSearchParams({ id: shipment.providerShipmentId })}`, undefined, { operation: "courier_refresh", orderId: data.order.id })
    : await bobGoRequest(`/shipments?${new URLSearchParams({ limit: "100", offset: "0", start_date: shipment.updatedAt.toISOString().slice(0, 10), order: "desc" })}`, undefined, { operation: "courier_refresh", orderId: data.order.id });
  const matches: Record<string, unknown>[] = [];
  function walk(value: unknown) {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const item = record(value);
    if (item.id && (shipment!.providerShipmentId ? textValue(item.id) === shipment!.providerShipmentId
      : item.custom_tracking_reference === shipment!.waybillReference)) matches.push(item);
    Object.values(item).forEach(child => { if (child && typeof child === "object") walk(child); });
  }
  walk(response);
  if (matches.length !== 1) throw new ShippingConflict("The shipment could not be matched safely. Check this order in Bob Go or contact your website administrator. Do not create a duplicate waybill.");
  await saveShipmentResponse(data.order.id, matches[0], shipment.waybillReference || orderNumber);
  return { courierStatus: textValue(matches[0].status), submissionStatus: textValue(matches[0].submission_status) };
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
