import { LinkedBookingConflict } from "./linked-booking-policy.ts";
import { bobGoAddressesMatch } from "./address-policy.ts";
import { parseRates, record, textValue, type CourierBookingSnapshot, type CourierRate } from "./protocol.ts";

type Route = Pick<CourierBookingSnapshot, "collection" | "delivery">;
const invalid = () => new LinkedBookingConflict("Bob Go returned an unrecognised courier-rate response. No waybill was requested.");
const positiveId = (value: unknown) => (typeof value === "number" || typeof value === "string")
  && /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
const noPoint = (value: unknown) => value === undefined || value === null || value === 0 || value === "0";

export function linkedRateRequestMatches(remote: unknown, orderId: string, requestId: number) {
  const order = record(remote);
  return String(order.id) === orderId && positiveId(order.rate_request_id) && Number(order.rate_request_id) === requestId;
}

// Bob Go's new_rates_modal response is a flat list per delivery category, not
// provider_rate_requests. Its wrapper can omit order.id: bind the request to
// the exact order via a separate GET before using any rates.
export function readLinkedRates(value: unknown, orderId: string, route: Route, expectedRequestId?: number) {
  const outer = record(value), wrapped = Object.hasOwn(outer, "order"), body = wrapped ? record(outer.order) : outer;
  if (wrapped && !Object.keys(body).length) throw invalid();
  const nested = Object.hasOwn(body, "rate_request"), request = nested ? record(body.rate_request) : body;
  if (nested && body.id !== undefined && String(body.id) !== orderId || body.order_id !== undefined && String(body.order_id) !== orderId) throw invalid();
  const modern = Object.hasOwn(request, "should_poll") || Object.hasOwn(request, "door_rates");
  const rawId = modern ? request.rate_request_id : request.id ?? request.rate_request_id;
  if (!positiveId(rawId)) throw invalid();
  const requestId = Number(rawId);
  if (expectedRequestId !== undefined && requestId !== expectedRequestId) throw new LinkedBookingConflict("The Bob Go quote reference changed. Compare couriers again; no waybill was requested.");
  const provider = route.collection.point?.providerSlug || route.delivery.point?.providerSlug;
  if (!modern) {
    if (!Array.isArray(request.provider_rate_requests) || request.provider_rate_requests.length > 100) throw invalid();
    const statuses = request.provider_rate_requests.map(row => textValue(record(row).status));
    const pendingStatuses = ["pending", "queued", "processing", "pending-rates"];
    if (statuses.some(status => ![...pendingStatuses, "success", "failed", "error", "timeout"].includes(status))) throw invalid();
    return { requestId, rates: parseRates(request, provider), pending: statuses.some(status => pendingStatuses.includes(status)) };
  }
  if (typeof request.should_poll !== "boolean" || ["door_rates", "pickup_point_rates", "on_demand_rates"].some(key => !Array.isArray(request[key]) || (request[key] as unknown[]).length > 1000)) throw invalid();
  const point = route.delivery.point;
  const doorRates = request.door_rates as unknown[];
  // Bob Box sender-locker services can be labelled "pickup-point" even in
  // door_rates. Accept that label only for the verified locker-to-home route;
  // never infer the customer's destination from this service label alone.
  const senderLockerToHome = !point && route.delivery.kind === "door" && route.collection.kind === "pickup_point" && Boolean(route.collection.point)
    && String(request.collection_pickup_point_location_id) === route.collection.point?.id
    && ["street_address", "local_area", "city", "zone", "country", "code"].every(key => textValue(record(route.delivery.address)[key]).trim())
    && bobGoAddressesMatch(record(request.delivery_address), record(route.delivery.address));
  const candidates = point ? request.pickup_point_rates as unknown[] : [...doorRates, ...request.on_demand_rates as unknown[]];
  const rates: CourierRate[] = [];
  for (const value of candidates) {
    const row = record(value), amount = row.rate_amount;
    if (row.status !== "success" || row.is_failed !== false || row.is_disabled !== false || row.has_insufficient_funds_can_make_payment === true
      || row.error_message || !(typeof amount === "number" || typeof amount === "string" && amount.trim() !== "") || !Number.isFinite(Number(amount)) || Number(amount) <= 0) continue;
    const slug = textValue(row.provider_slug), code = textValue(row.service_level_code);
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(slug) || !code.trim() || code.length > 100 || provider && slug !== provider) continue;
    if (point ? String(row.pickup_point_location_id) !== point.id || !["locker", "counter"].includes(textValue(row.service_level_delivery_type))
      : !noPoint(row.pickup_point_location_id) || !(row.service_level_delivery_type === "door"
        || senderLockerToHome && doorRates.includes(value) && row.service_level_delivery_type === "pickup-point"
          && (row.pickup_point_location_id === 0 || row.pickup_point_location_id === "0"))) continue;
    if (route.collection.point ? String(row.collection_pickup_point_location_id) !== route.collection.point.id
      : !noPoint(row.collection_pickup_point_location_id)) continue;
    rates.push({ providerSlug: slug, providerName: textValue(row.provider_name) || slug, serviceCode: code,
      serviceName: textValue(row.service_level_name) || code, amount: Number(amount) });
  }
  return { requestId, rates: rates.sort((a, b) => a.amount - b.amount), pending: request.should_poll };
}
