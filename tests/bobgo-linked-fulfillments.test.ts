import assert from "node:assert/strict";
import test from "node:test";
import { activeLinkedFulfillments, linkedFulfillmentReference, retiredLinkedFulfillments, verifyRetiredShipments } from "../lib/integrations/bobgo/linked-fulfillment-policy.ts";
import { assertNoFulfillments } from "../lib/integrations/bobgo/linked-booking-policy.ts";
import { buildBobGoOrderPayload } from "../lib/integrations/bobgo/order-sync-policy.ts";
import { inspectLinkedBookingPermissions, linkedBookingPermissions, linkedWaybillChangePermissions } from "../lib/integrations/bobgo/permissions.ts";

const expected = buildBobGoOrderPayload({ orderNumber: "MM-RETIRE-TEST", contact: { name: "TEST Buyer", email: "test@example.invalid", phone: "0821234567" },
  address: { company: "", line1: "10 Example Road", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" },
  subtotal: 450, deliveryFee: 99, total: 549, discountAmount: 0, items: [{ sku: "TEST", description: "TEST Product", unitPrice: 450, quantity: 1, weightGrams: 120 }] });
const remote = { ...expected, id: 10, order_items: expected.order_items.map(item => ({ ...item, id: 20, fulfilled_qty: 0 })) };
const scope = { environment: "sandbox", channelRef: "store.example.invalid", remoteOrderId: "10" };
const proof = { ...scope, fulfillmentId: "30", shipmentId: "40", trackingNumber: "TEST-OLD" };
const shipment = { status: "cancelled", provider: "bobgo-sandbox", providerShipmentId: "40", trackingNumber: "TEST-OLD", bookingSnapshot: { linkedOrder: { channelRef: scope.channelRef, remoteOrderId: "10" } } };
const history = [{ action: "waybill_replacement_prepared", before: { shipment }, after: { linkedCancellation: proof } }];
const old = { id: 30, order_id: 10, method: "shipment", type: "original", status: "cancelled", method_id: 40, method_reference: "TEST-OLD", items: [{ order_item_id: 20, qty: 1 }] };
const retired = retiredLinkedFulfillments(history, scope);
const response = { order_fulfillments: [{ order_fulfillment: old }], count: 1 };

test("only exact locally archived full cancelled fulfilments are retired; one new active waybill remains visible", () => {
  assertNoFulfillments(activeLinkedFulfillments(response, remote, expected, retired));
  const next = { ...old, id: 31, method_id: 41, method_reference: "TEST-NEW", status: "success" };
  const body = activeLinkedFulfillments({ order_fulfillments: [...response.order_fulfillments, { order_fulfillment: next }], count: 2 }, remote, expected, retired);
  assert.equal(body.count, 1);
  assert.deepEqual(linkedFulfillmentReference(body, remote, expected), { fulfillmentId: "31", shipmentId: "41", trackingNumber: "TEST-NEW", cancelled: false });
  assert.throws(() => assertNoFulfillments(body));
  assert.throws(() => linkedFulfillmentReference(response, remote, expected));
  assert.equal(linkedFulfillmentReference(response, remote, expected, true).cancelled, true);
});

test("foreign, split, returned, reactivated, missing and ambiguous cancellation records fail closed", () => {
  for (const changed of [{ ...old, order_id: 99 }, { ...old, method_id: 99 }, { ...old, method_reference: "OTHER" }, { ...old, status: "success" },
    { ...old, type: "return" }, { ...old, items: [{ order_item_id: 20, qty: 2 }] }, { ...old, items: [] }]) {
    assert.throws(() => activeLinkedFulfillments({ order_fulfillments: [{ order_fulfillment: changed }], count: 1 }, remote, expected, retired));
  }
  for (const body of [{ order_fulfillments: [], count: 0 }, { ...response, count: 2 }, { ...response, has_more: true }, { ...response, next_page: "next" },
    { order_fulfillments: [...response.order_fulfillments, ...response.order_fulfillments], count: 2 }]) {
    assert.throws(() => activeLinkedFulfillments(body, remote, expected, retired));
  }
  // An unexplained cancellation is never silently ignored.
  assert.throws(() => assertNoFulfillments(activeLinkedFulfillments(response, remote, expected, [])));
});

test("cancellation proof must match the recorded shipment and channel; note text cannot authorise a replacement", () => {
  assert.deepEqual(retiredLinkedFulfillments([{ ...history[0], action: "private_note" }], scope), []);
  for (const changed of [{ ...proof, channelRef: "other.example.invalid" }, { ...proof, remoteOrderId: "11" }, { ...proof, shipmentId: "41" }, { ...proof, trackingNumber: "OTHER" }]) {
    assert.throws(() => retiredLinkedFulfillments([{ ...history[0], after: { linkedCancellation: changed } }], scope));
  }
  assert.throws(() => retiredLinkedFulfillments([...history, ...history], scope));
  assert.throws(() => retiredLinkedFulfillments([{ ...history[0], before: { shipment: { ...shipment, status: "booked" } } }], scope));
});

test("retired courier bookings must independently remain cancelled, not merely cancelled-by-courier", async () => {
  const row = { id: 40, tracking_reference: "TEST-OLD", status: "cancelled" };
  await verifyRetiredShipments(retired, async id => { assert.equal(id, "40"); return row; });
  for (const changed of [{ ...row, status: "cancelled-by-courier" }, { ...row, status: "pending-collection" }, { ...row, tracking_reference: "OTHER" },
    { ...row, collected_date: "2026-10-19" }]) await assert.rejects(verifyRetiredShipments(retired, async () => changed));
});

test("linked cancellation requires its own POST permissions, not just booking permission", () => {
  const onlyBooking = { user: { role: { permissions: [...linkedBookingPermissions] } } };
  assert.equal(inspectLinkedBookingPermissions(onlyBooking).allowed, true);
  assert.equal(inspectLinkedBookingPermissions(onlyBooking, linkedWaybillChangePermissions).allowed, false);
});
