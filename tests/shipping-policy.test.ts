import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateShippingQuote,
  FREE_DELIVERY_THRESHOLD,
  STANDARD_DELIVERY_FEE,
} from "../lib/shipping/policy.ts";
import { shipmentBookingBlockers } from "../lib/shipping/readiness.ts";
import {
  HAWA_AND_AMINA_PACKAGE,
  resolveVerifiedPackage,
} from "../lib/shipping/packages.ts";

test("delivery costs R99 below the free-delivery threshold", () => {
  assert.deepEqual(calculateShippingQuote(450, "delivery"), {
    subtotal: 450,
    deliveryFee: STANDARD_DELIVERY_FEE,
    total: 549,
    qualifiesForFreeDelivery: false,
    amountUntilFreeDelivery: 1050,
  });
});

test("delivery is free from R1500", () => {
  assert.deepEqual(calculateShippingQuote(FREE_DELIVERY_THRESHOLD, "delivery"), {
    subtotal: 1500,
    deliveryFee: 0,
    total: 1500,
    qualifiesForFreeDelivery: true,
    amountUntilFreeDelivery: 0,
  });
});

test("collection never charges a delivery fee", () => {
  assert.equal(calculateShippingQuote(450, "collection").total, 450);
  assert.equal(calculateShippingQuote(450, "collection").deliveryFee, 0);
});

test("an empty basket never shows a delivery charge", () => {
  assert.equal(calculateShippingQuote(0, "delivery").total, 0);
  assert.equal(calculateShippingQuote(0, "delivery").deliveryFee, 0);
});

test("Bob Go booking remains blocked until every operational detail is ready", () => {
  const blockers = shipmentBookingBlockers({
    deliveryMethod: "courier",
    paymentStatus: "pending",
    hasDeliveryAddress: true,
    integrationEnabled: false,
    apiTokenConfigured: false,
    senderContactConfigured: true,
  });
  assert.ok(blockers.includes("Payment must be confirmed first."));
  assert.ok(blockers.includes("Packed weight is still required."));
  assert.ok(blockers.includes("Bob Go booking is intentionally disabled."));
});

test("a complete paid delivery can be marked ready", () => {
  assert.deepEqual(shipmentBookingBlockers({
    deliveryMethod: "courier",
    paymentStatus: "paid",
    hasDeliveryAddress: true,
    weightGrams: 500,
    lengthCm: 30,
    widthCm: 20,
    heightCm: 8,
    integrationEnabled: true,
    apiTokenConfigured: true,
    senderContactConfigured: true,
    pickupPointLocationId: "api-location-id",
  }), []);
});

test("the verified Hawa and Amina parcel is applied to that exact combination", () => {
  assert.deepEqual(resolveVerifiedPackage([
    { sku: "HAWA-BLK-S", quantity: 1 },
    { sku: "AMINA-LAV-OS", quantity: 1 },
  ]), HAWA_AND_AMINA_PACKAGE);
});

test("unmeasured product combinations do not receive estimated dimensions", () => {
  assert.equal(resolveVerifiedPackage([{ sku: "HAWA-BLK-S", quantity: 1 }]), null);
  assert.equal(resolveVerifiedPackage([
    { sku: "HAWA-BLK-S", quantity: 2 },
    { sku: "AMINA-LAV-OS", quantity: 1 },
  ]), null);
});
