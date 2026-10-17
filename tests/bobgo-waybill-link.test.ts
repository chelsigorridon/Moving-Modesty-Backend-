import assert from "node:assert/strict";
import test from "node:test";
import { existingWaybillReference, verifiedExistingWaybill } from "../lib/integrations/bobgo/waybill-link-policy.ts";
import { buildBobGoOrderPayload, orderSyncView } from "../lib/integrations/bobgo/order-sync-policy.ts";

const expected = buildBobGoOrderPayload({ orderNumber: "MM-TEST-LINK", contact: { name: "TEST Customer", email: "customer@example.invalid", phone: "0821234567" },
  address: { company: "", line1: "10 Example Street", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" },
  deliveryFee: 99, subtotal: 900, total: 998.99, discountAmount: 0.01,
  items: [{ sku: "TEST-SKU", description: "TEST scarf", quantity: 2, unitPrice: 450, weightGrams: 120 }] });
const remote = { ...expected, id: 101, order_items: expected.order_items.map((item, i) => ({ ...item, id: 201 + i })) };
const fulfillment = { id: 301, order_id: 101, channel_order_number: expected.channel_order_number, method: "shipment", status: "success", method_id: 401,
  method_reference: "TEST-WAYBILL", order_items: remote.order_items.map(item => ({ ...item, fulfilled_qty: item.qty })) };
const body = { order_fulfillments: [fulfillment] };
const shipment = { id: 401, tracking_reference: "TEST-WAYBILL", submission_status: "success", status: "pending-collection", provider_slug: "demo", service_level_code: "ECO",
  collection_location_type: "door", delivery_location_type: "door", delivery_address: expected.delivery_address, time_created: "2026-10-17T06:00:00Z",
  delivery_contact_name: "TEST Customer", delivery_contact_email: expected.customer_email, delivery_contact_mobile_number: expected.customer_phone };
const now = Date.parse("2026-10-17T08:00:00Z");

test("waybill discovery requires a full, exact order fulfilment and independently confirmed shipment", () => {
  const reference = existingWaybillReference(body, remote, expected)!;
  assert.deepEqual(reference, { shipmentId: "401", trackingNumber: "TEST-WAYBILL" });
  assert.equal(verifiedExistingWaybill(shipment, reference, expected, now).providerSlug, "demo");
  assert.equal(existingWaybillReference({ order_fulfillments: [] }, remote, expected), null);
  const nested = { order_fulfillments: [{ order_fulfillment: { ...fulfillment, order_items: undefined,
    items: remote.order_items.map(item => ({ order_item_id: item.id, qty: item.qty })) }, shipment: { id: 401, tracking_reference: "TEST-WAYBILL" } }] };
  assert.deepEqual(existingWaybillReference(nested, remote, expected), reference);
});

test("foreign, partial, multiple, return, unknown and incomplete fulfilments are never silently linked", () => {
  for (const changed of [{ ...fulfillment, order_id: 999 }, { ...fulfillment, channel_order_number: "MM-OTHER" },
    { ...fulfillment, method: "collection" }, { ...fulfillment, is_return: true }, { ...fulfillment, status: "pending" },
    { ...fulfillment, order_items: [] }, { ...fulfillment, order_items: [fulfillment.order_items[0]] },
    { ...fulfillment, order_items: fulfillment.order_items.map(item => ({ ...item, fulfilled_qty: 999 })) },
    { ...fulfillment, method_id: "../shipments" }, { ...fulfillment, method_reference: "https://host.invalid/private" }]) {
    assert.throws(() => existingWaybillReference({ order_fulfillments: [changed] }, remote, expected));
  }
  for (const changed of [{ data: [] }, { order_fulfillments: [fulfillment, fulfillment] }, { ...body, has_more: true }, { ...body, total: 2 }]) {
    assert.throws(() => existingWaybillReference(changed, remote, expected));
  }
  assert.throws(() => existingWaybillReference(body, { ...remote, customer_email: "foreign@example.invalid" }, expected));
  assert.throws(() => existingWaybillReference(body, { ...remote, order_items: expected.order_items }, expected), /needs checking/);
});

test("a wrong, cancelled, unconfirmed or differently addressed waybill fails closed", () => {
  const reference = existingWaybillReference(body, remote, expected)!;
  for (const changed of [{ id: 999 }, { tracking_reference: "OTHER" }, { submission_status: "failed-will-retry" }, { status: "cancelled" },
    { provider_slug: "bad slug" }, { is_return: true }, { collection_location_type: "unknown" }, { service_level_code: "" },
    { time_created: "invalid" }, { time_created: "2099-01-01T00:00:00Z" }, { delivery_contact_email: "foreign@example.invalid" },
    { delivery_contact_name: "Wrong Recipient" }, { delivery_contact_mobile_number: "0827654321" }, { delivery_address: { ...expected.delivery_address, code: "8000" } }]) {
    assert.throws(() => verifiedExistingWaybill({ ...shipment, ...changed }, reference, expected, now));
  }
  assert.equal(orderSyncView({ status: "synced", lastErrorCode: null, remoteOrderId: "101", waybillLinkErrorCode: "fulfillment_multiple" }, true).status, "Needs attention");
  assert.equal(orderSyncView({ status: "synced", lastErrorCode: null, remoteOrderId: "101", waybillLinkErrorCode: "fulfillment_multiple" }).status, "Not enabled");
});
