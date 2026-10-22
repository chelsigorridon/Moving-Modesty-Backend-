import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildBobGoOrderPayload, getOrderSyncConfiguration, matchRemoteOrder, orderSyncView, stableOrderPayload, type BobGoOrderSource } from "../lib/integrations/bobgo/order-sync-policy.ts";

const source: BobGoOrderSource = { orderNumber: "MM-SYNC-TEST", contact: { name: "TEST Customer", email: "TEST@example.invalid", phone: "082 123 4567" },
  address: { company: "", line1: "10 Example Road", line2: "Unit 1", suburb: "Example", city: "Cape Town", province: "western cape", postalCode: "7800" },
  deliveryFee: 99, subtotal: 450, total: 549, discountAmount: 0,
  items: [{ sku: "TEST-SKU", description: "TEST Product — Black Small", quantity: 1, unitPrice: 450, weightGrams: 120 }] };

test("the review release cannot activate order sync through environment flags", () => {
  assert.equal(getOrderSyncConfiguration().enabled, false);
  const code = readFileSync(new URL("../lib/integrations/bobgo/order-sync.ts", import.meta.url), "utf8");
  assert.doesNotMatch(code, /\bfetch\(|bobGoRequest\(|getBobGoApiToken/);
  const payment = readFileSync(new URL("../lib/integrations/payfast/notification.ts", import.meta.url), "utf8");
  assert.match(payment, /if \(nextStatus === "paid" && !courierTest\) await enqueuePaidBobGoOrder\(transaction, payment.orderId\)/);
  assert.match(payment, /if \(lockedOrder.paymentStatus === "paid" && !courierTest\) await enqueuePaidBobGoOrder\(transaction, payment.orderId\)/);
});

test("order payload normalizes contacts and province, uses measured per-item weights and excludes private data", () => {
  const payload = buildBobGoOrderPayload(source);
  assert.equal(payload.customer_email, "test@example.invalid");
  assert.equal(payload.customer_phone, "0821234567");
  assert.equal(payload.delivery_address.zone, "Western Cape");
  assert.equal(payload.delivery_address.street_address, "10 Example Road, Unit 1");
  assert.equal(payload.order_items[0].unit_weight_kg, 0.12);
  assert.equal(payload.buyer_selected_shipping_cost, 99);
  assert.equal(payload.payment_status, "paid");
  assert.doesNotMatch(JSON.stringify(payload), /privateNote|AUTH_SECRET|paymentReference|providerPaymentId/);
  assert.throws(() => buildBobGoOrderPayload({ ...source, items: [{ ...source.items[0], weightGrams: null }] }), /weights/);
  assert.equal(buildBobGoOrderPayload({ ...source, discountAmount: 10, total: 539 }).order_items[0].unit_price, 440);
  assert.throws(() => buildBobGoOrderPayload({ ...source, total: 0 }), /Check the delivery/);
});

test("discount mapping preserves paid cents, quantities and measured weights even when a quantity needs two price tiers", () => {
  for (const quantity of [1, 2, 3, 7, 99]) for (const discountCents of [0, 1, 5, 99, 777]) {
    const subtotal = 450 * quantity;
    const payload = buildBobGoOrderPayload({ ...source, subtotal, discountAmount: discountCents / 100, total: subtotal - discountCents / 100 + 99,
      items: [{ ...source.items[0], quantity }] });
    assert.equal(payload.order_items.reduce((sum, item) => sum + Math.round(item.unit_price * 100) * item.qty, 0), subtotal * 100 - discountCents);
    assert.equal(payload.order_items.reduce((sum, item) => sum + item.qty, 0), quantity);
    assert.ok(payload.order_items.every(item => item.unit_weight_kg === 0.12));
    assert.equal(matchRemoteOrder({ ...payload, id: 1234 }, payload), "1234");
  }
  const payload = buildBobGoOrderPayload({ ...source, subtotal: 870, discountAmount: 0.01, total: 968.99,
    items: [...source.items, { ...source.items[0], sku: "SECOND", unitPrice: 420 }] });
  assert.equal(payload.order_items.reduce((sum, item) => sum + Math.round(item.unit_price * 100) * item.qty, 0), 86999);
  assert.throws(() => buildBobGoOrderPayload({ ...source, discountAmount: 451, total: 98 }), /Check the delivery/);
});

test("reconciliation requires matching reference, recipient, address, payment, line items and delivery cost", () => {
  const payload = buildBobGoOrderPayload(source), remote = { ...payload, id: 1234 };
  assert.equal(matchRemoteOrder(remote, payload), "1234");
  for (const change of [{ id: 0 }, { channel_order_number: "MM-ANOTHER" }, { customer_email: "another@example.invalid" },
    { payment_status: "unpaid" }, { buyer_selected_shipping_cost: 0 }, { buyer_selected_shipping_cost: null },
    { delivery_address: { ...payload.delivery_address, code: "8000" } }, { order_items: [{ ...payload.order_items[0], qty: 2 }] }]) {
    assert.equal(matchRemoteOrder({ ...remote, ...change }, payload), null);
  }
  assert.equal(orderSyncView(undefined).status, "Not enabled");
  assert.equal(orderSyncView({ status: "checking", lastErrorCode: "create_unconfirmed", remoteOrderId: null }, true).status, "Needs checking");
});

test("PostgreSQL JSONB key ordering does not turn an unchanged payload into a delivery edit", () => {
  const payload = buildBobGoOrderPayload(source);
  const reordered = JSON.parse(JSON.stringify(payload, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, value[key]])) : value));
  assert.equal(stableOrderPayload(reordered), stableOrderPayload(payload));
  assert.notEqual(stableOrderPayload({ ...payload, buyer_selected_shipping_cost: 0 }), stableOrderPayload(payload));
});

test("Bob Go's one-decimal item weight read-back does not lose an otherwise exact order link", () => {
  const payload = buildBobGoOrderPayload({ ...source, items: [{ ...source.items[0], weightGrams: 212 }] });
  const remote = { ...payload, id: 61586602, order_items: [{ ...payload.order_items[0], unit_weight_kg: 0.2 }] };
  assert.equal(matchRemoteOrder(remote, payload), "61586602");
  for (const weight of [0.21, 0.3, 0, -0.2, null, "", undefined]) {
    assert.equal(matchRemoteOrder({ ...remote, order_items: [{ ...remote.order_items[0], unit_weight_kg: weight }] }, payload), null);
  }
  assert.equal(matchRemoteOrder({ ...remote, customer_email: "wrong@example.invalid" }, payload), null);
  assert.equal(matchRemoteOrder({ ...remote, order_items: [{ ...remote.order_items[0], qty: 2 }] }, payload), null);
  assert.equal(payload.order_items[0].unit_weight_kg, 0.212, "Original measured item weight is unchanged");
  const unresolved = orderSyncView({ status: "needs_attention", lastErrorCode: "delivery_changed", remoteOrderId: null }, true, true);
  assert.doesNotMatch(unresolved.message!, /Compare couriers here/);
});
