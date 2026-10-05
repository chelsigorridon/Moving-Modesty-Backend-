import assert from "node:assert/strict";
import test from "node:test";
import { canRetryNotification, dispatchTracking, shouldNotifyOrderStatus } from "../lib/order-notifications.ts";
import type { AdminOrder } from "../lib/admin-types.ts";

test("dispatch tracking comes from a confirmed shipment, never a quote, demo or attempt reference", () => {
  const shipping = { status: "Booked", trackingNumber: "BG123456789", waybillReference: "MM-ATTEMPT", trackingUrl: "https://untrusted.invalid/", environment: "production" } as AdminOrder["shipping"];
  assert.deepEqual(dispatchTracking({ deliveryMethod: "Courier", shipping }), { number: "BG123456789", url: "https://track.bobgo.co.za/", sandbox: false });
  for (const trackingNumber of [undefined, "", "DEMO-FAKE", "TEST-FAKE"]) assert.throws(() => dispatchTracking({ deliveryMethod: "Courier", shipping: { ...shipping!, trackingNumber } }));
  assert.throws(() => dispatchTracking({ deliveryMethod: "Collection", shipping }));
  assert.throws(() => dispatchTracking({ deliveryMethod: "Courier", shipping: { ...shipping!, status: "Booking" } }));
});

test("internal preparation does not email customers; collection ready and dispatch do", () => {
  for (const status of ["New", "Confirmed", "Preparing"] as const) assert.equal(shouldNotifyOrderStatus("Courier", status), false);
  assert.equal(shouldNotifyOrderStatus("Courier", "Ready"), false);
  assert.equal(shouldNotifyOrderStatus("Collection", "Ready"), true);
  assert.equal(shouldNotifyOrderStatus("Courier", "Dispatched"), true);
});

test("outdated notifications cannot be retried after the order moves on", () => {
  const order = { status: "Delivered", paymentStatus: "Paid", deliveryMethod: "Courier" } as const;
  assert.equal(canRetryNotification("order-status-dispatched", order), false);
  assert.equal(canRetryNotification("order-status-delivered", order), true);
  assert.equal(canRetryNotification("paid-order-customer", order), true);
  assert.equal(canRetryNotification("contact-message", order), false);
});
