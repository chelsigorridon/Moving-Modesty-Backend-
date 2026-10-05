import assert from "node:assert/strict";
import test from "node:test";
import { assertCheckoutEditable, checkoutContentSnapshot, sameCheckoutContents, isPaymentFinal, readOrderCustomer } from "../lib/checkout-safety.ts";
import { checkoutOrderSchema } from "../lib/checkout-input.ts";

test("paid, refunded and closed orders cannot be edited through checkout", () => {
  for (const order of [{ status: "new", paymentStatus: "paid" }, { status: "new", paymentStatus: "refunded" },
    { status: "cancelled", paymentStatus: "failed" }, { status: "confirmed", paymentStatus: "paid" }]) {
    assert.throws(() => assertCheckoutEditable(order), /paid or closed/);
  }
  assert.doesNotThrow(() => assertCheckoutEditable({ status: "new", paymentStatus: "failed" }));
  assert.equal(isPaymentFinal("paid"), true);
  assert.equal(isPaymentFinal("refunded"), true);
  assert.equal(isPaymentFinal("failed"), false);
});

test("an attempted payment snapshot detects changed items, address, identity or total", () => {
  const input = { customer: { firstName: "Test", lastName: "Customer", email: "test@example.com", phone: "27766514548" },
    deliveryMethod: "courier", total: "519.00", items: [{ sku: "AMINA-LAV-OS", quantity: 1 }],
    address: { line1: "10 Test Street", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "0081" } };
  const snapshot = checkoutContentSnapshot(input);
  assert.equal(sameCheckoutContents(snapshot, checkoutContentSnapshot({ ...input, total: 519 })), true);
  for (const changed of [{ ...input, total: 520 }, { ...input, items: [{ sku: "AMINA-LAV-OS", quantity: 2 }] },
    { ...input, customer: { ...input.customer, phone: "0821234567" } }, { ...input, address: { ...input.address, postalCode: "7800" } }]) {
    assert.equal(sameCheckoutContents(snapshot, checkoutContentSnapshot(changed)), false);
  }
});

test("an order's identity does not follow changes to a shared customer profile", () => {
  const saved = { firstName: "Original", lastName: "Customer", email: "test@example.com", phone: "0821234567" };
  const profile = { ...saved, firstName: "Changed", phone: "0837654321" };
  assert.deepEqual(readOrderCustomer(saved, profile), saved);
  assert.deepEqual(readOrderCustomer(null, profile), profile);
});

test("delivery rejects alphabetic/invalid postcodes and preserves leading zeroes", () => {
  const input = { checkoutToken: "c4c5b18e-4e64-4d3b-845e-d6432157f723", stage: "complete", fulfilmentMethod: "delivery",
    customer: { firstName: "Test", lastName: "Customer", email: "TEST@example.com", phone: "+27 (82) 123-4567" },
    address: { line1: "10 Test Street", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "0081" },
    items: [{ sku: "AMINA-LAV-OS", quantity: 1 }] };
  const valid = checkoutOrderSchema.parse(input);
  assert.equal(valid.address?.postalCode, "0081");
  assert.equal(valid.customer.phone, "+27821234567");
  assert.equal(valid.customer.email, "test@example.com");
  for (const postalCode of ["ABC", "800", "80000", "78 00", "78O0"]) {
    assert.equal(checkoutOrderSchema.safeParse({ ...input, address: { ...input.address, postalCode } }).success, false);
  }
  assert.equal(checkoutOrderSchema.safeParse({ ...input, address: { ...input.address, province: "ABC" } }).success, false);
  assert.equal(checkoutOrderSchema.safeParse({ ...input, customer: { ...input.customer, phone: "ABC" } }).success, false);
});
