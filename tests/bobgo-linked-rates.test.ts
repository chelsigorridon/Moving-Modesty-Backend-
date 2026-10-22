import assert from "node:assert/strict";
import test from "node:test";
import { readLinkedRates, linkedRateRequestMatches } from "../lib/integrations/bobgo/linked-rates.ts";
import type { CourierBookingSnapshot } from "../lib/integrations/bobgo/protocol.ts";

const route = { collection: { kind: "door" }, delivery: { kind: "door" } } as Pick<CourierBookingSnapshot, "collection" | "delivery">;
const rate = { rate_response_id: 100, provider_slug: "demo-a", provider_name: "Example Courier", service_level_code: "LPF", service_level_name: "Local Priority Flyer (LPF)",
  rate_amount: 119.23, status: "success", is_failed: false, is_disabled: false, has_insufficient_funds_can_make_payment: false,
  service_level_delivery_type: "door", pickup_point_location_id: 0, collection_pickup_point_location_id: null };
const request = (overrides: Record<string, unknown> = {}) => ({ rate_request_id: 3000, should_poll: false, door_rates: [rate], pickup_point_rates: [], on_demand_rates: [], ...overrides });

test("the observed modern rate response needs no order.id and preserves every door-delivery service", () => {
  const rows = Array.from({ length: 17 }, (_, index) => ({ ...rate, service_level_code: `SERVICE-${index}`, rate_amount: 100 + index }));
  const result = readLinkedRates({ rate_request: request({ door_rates: rows }) }, "77", route);
  assert.equal(result.requestId, 3000); assert.equal(result.pending, false); assert.equal(result.rates.length, 17);
  assert.deepEqual(result.rates[0], { providerSlug: "demo-a", providerName: "Example Courier", serviceCode: "SERVICE-0", serviceName: rate.service_level_name, amount: 100 });
  assert.equal(linkedRateRequestMatches({ id: 77, rate_request_id: 3000 }, "77", 3000), true);
  assert.equal(linkedRateRequestMatches({ id: 88, rate_request_id: 3000 }, "77", 3000), false);
  assert.equal(linkedRateRequestMatches({ id: 77, rate_request_id: 3001 }, "77", 3000), false);
});

test("modern waiting follows should_poll even when partial prices are already present", () => {
  assert.equal(readLinkedRates({ rate_request: request({ should_poll: true }) }, "77", route).pending, true);
  assert.equal(readLinkedRates({ order: { id: 77, rate_request: request() } }, "77", route).pending, false);
  assert.equal(readLinkedRates(request(), "77", route).rates.length, 1);
});

test("pickup-point rates cannot silently replace a customer's door delivery", () => {
  const pickup = { ...rate, service_level_delivery_type: "locker", pickup_point_location_id: 91 };
  assert.equal(readLinkedRates({ rate_request: request({ pickup_point_rates: [pickup] }) }, "77", route).rates.length, 1);
  const selected = { ...route, delivery: { kind: "pickup_point", point: { id: "91", providerSlug: "demo-a" } } } as typeof route;
  const result = readLinkedRates({ rate_request: request({ pickup_point_rates: [pickup, { ...pickup, pickup_point_location_id: 92 }, { ...pickup, provider_slug: "demo-b" }] }) }, "77", selected);
  assert.equal(result.rates.length, 1);
  assert.equal(result.rates[0].serviceCode, "LPF");
});

test("locker collection rates retain both the selected point and its provider", () => {
  const selected = { ...route, collection: { kind: "pickup_point", point: { id: "90", providerSlug: "demo-a" } } } as typeof route;
  const result = readLinkedRates({ rate_request: request({ door_rates: [rate, { ...rate, collection_pickup_point_location_id: 90 }, { ...rate, collection_pickup_point_location_id: 91 }] }) }, "77", selected);
  assert.equal(result.rates.length, 1);
});

test("disabled, failed, unfunded, malformed, non-positive and wrong-route entries are not bookable options", () => {
  for (const changes of [{ is_disabled: true }, { is_failed: true }, { has_insufficient_funds_can_make_payment: true }, { status: "failed" },
    { rate_amount: 0 }, { rate_amount: -1 }, { rate_amount: null }, { rate_amount: "" }, { rate_amount: NaN }, { provider_slug: "../bad" },
    { service_level_code: "" }, { pickup_point_location_id: 91 }, { collection_pickup_point_location_id: 90 }]) {
    const result = readLinkedRates({ rate_request: request({ door_rates: [{ ...rate, ...changes }] }) }, "77", route);
    assert.equal(result.rates.length, 0, JSON.stringify(changes));
  }
});

test("order/request identity changes and unknown response formats fail closed", () => {
  for (const value of [{}, { order: null }, { id: 88, rate_request: request() }, { order_id: 88, rate_request: request() },
    { rate_request: request({ rate_request_id: null }) }, { rate_request: request({ should_poll: undefined }) },
    { rate_request: request({ door_rates: {} }) }, { rate_request: request({ pickup_point_rates: undefined }) }]) {
    assert.throws(() => readLinkedRates(value, "77", route));
  }
  assert.throws(() => readLinkedRates({ rate_request: request({ rate_request_id: 3001 }) }, "77", route, 3000), /quote reference changed/);
});

test("legacy responses remain supported without treating an unknown legacy status as completed", () => {
  const legacy = { id: 77, rate_request: { id: 3000, provider_rate_requests: [{ provider_slug: "demo-a", provider_name: "Example Courier", status: "success", responses: [{ status: "success", service_level_code: "ECO", rate_amount: 95 }] }] } };
  assert.equal(readLinkedRates(legacy, "77", route).rates.length, 1);
  legacy.rate_request.provider_rate_requests[0].status = "pending";
  assert.equal(readLinkedRates(legacy, "77", route).pending, true);
  legacy.rate_request.provider_rate_requests[0].status = "unexpected";
  assert.throws(() => readLinkedRates(legacy, "77", route));
});
