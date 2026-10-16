import assert from "node:assert/strict";
import test from "node:test";
import { bobGoDoorAddress, courierPlanInput, courierRouteLabel, deliveryEditInput, planProvider } from "../lib/delivery-input.ts";

const contact = { name: "Test Sender", email: " TEST@EXAMPLE.COM ", phone: "+27 (82) 123-4567" };
const address = { line1: "10 Test Street", suburb: "Test Suburb", city: "Cape Town", province: " western cape ", postalCode: "7800" };
const door = { kind: "door", contact, address };
const point = { kind: "pickup_point", contact, point: { id: "1156", providerSlug: "ie", name: "Test point" } };
const plan = { version: 1, collection: door, delivery: door };

test("door-to-door plans are not restricted to a pickup-point courier", () => {
  const parsed = courierPlanInput.parse(plan);
  assert.equal(planProvider(parsed), undefined);
  assert.equal(parsed.collection.contact.phone, "+27821234567");
  assert.equal(parsed.collection.contact.email, "test@example.com");
  assert.equal(parsed.collection.kind === "door" && parsed.collection.address.province, "Western Cape");
  assert.match(courierRouteLabel(parsed), /Courier collects from sender.*Customer's door/);
  assert.deepEqual(bobGoDoorAddress({ ...address, province: "Western Cape", line2: "Unit 2", company: "" }), {
    company: "", street_address: "10 Test Street, Unit 2", local_area: "Test Suburb", city: "Cape Town", zone: "Western Cape", country: "ZA", code: "7800",
  });
});

test("all four door and pickup-point combinations are validated", () => {
  for (const collection of [door, point]) for (const delivery of [door, point]) {
    const parsed = courierPlanInput.parse({ ...plan, collection, delivery, customerApprovedPickup: true });
    assert.equal(planProvider(parsed), collection.kind === "pickup_point" || delivery.kind === "pickup_point" ? "ie" : undefined);
  }
  assert.equal(courierPlanInput.safeParse({ ...plan, delivery: point }).success, false);
  assert.equal(courierPlanInput.safeParse({ ...plan, collection: point,
    delivery: { ...point, point: { ...point.point, providerSlug: "other" } }, customerApprovedPickup: true }).success, false);
});

test("saving delivery changes requires explicit confirmation and optimistic revision", () => {
  assert.equal(deliveryEditInput.safeParse({ action: "delivery", plan, expectedRevision: 0, confirmed: true }).success, true);
  assert.equal(deliveryEditInput.safeParse({ action: "delivery", plan, expectedRevision: 0 }).success, false);
  assert.equal(deliveryEditInput.safeParse({ action: "delivery", plan, expectedRevision: -1, confirmed: true }).success, false);
  assert.equal(deliveryEditInput.safeParse({ action: "private_note", note: "Internal only", expectedRevision: 1 }).success, true);
  assert.equal(deliveryEditInput.safeParse({ action: "private_note", note: "x".repeat(3001), expectedRevision: 1 }).success, false);
  assert.equal(courierPlanInput.safeParse({ ...plan, collection: { ...door, address: { ...address, postalCode: "1" } } }).success, false);
});
