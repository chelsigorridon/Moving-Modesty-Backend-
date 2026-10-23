import assert from "node:assert/strict";
import test from "node:test";
import { courierPlanInput } from "../lib/delivery-input.ts";
import { withCollectionOptions } from "../lib/shipping/collection-options.ts";

const contact = { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" };
const door = { kind: "door" as const, contact, address: { company: "", line1: "10 Example Street", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape" as const, postalCode: "7800" } };
const pickupPoint = { kind: "pickup_point" as const, contact, point: { id: "1156", providerSlug: "ie", name: "Constantia Emporium" } };
const schedule = { date: "2099-07-16", after: "09:00", before: "16:00" };
const plan = courierPlanInput.parse({ version: 1, collection: door, delivery: door, collectionSchedule: schedule });

test("saved collection alternatives and this order's window survive JSON storage and method changes", () => {
  const original = structuredClone(plan);
  const saved = withCollectionOptions(plan, { pickupPoint });
  const locker = courierPlanInput.parse(JSON.parse(JSON.stringify({ ...saved, collection: pickupPoint, collectionSchedule: undefined })));
  const restored = withCollectionOptions(locker);
  assert.deepEqual(restored.collectionOptions, { door: plan.collection, pickupPoint, doorSchedule: schedule });
  assert.equal(restored.collectionSchedule, undefined);
  assert.deepEqual(restored.delivery, plan.delivery);
  assert.deepEqual(plan, original, "Read helpers do not mutate stored order data");
});

test("an edited endpoint overrides its cached copy without clearing the opposite collection choice", () => {
  const saved = withCollectionOptions(plan, { pickupPoint });
  const changed = { ...door, address: { ...door.address, line1: "30 Updated Street" } };
  const next = withCollectionOptions({ ...saved, collection: changed });
  assert.equal(next.collectionOptions?.door?.address.line1, "30 Updated Street");
  assert.deepEqual(next.collectionOptions?.pickupPoint, pickupPoint);
  assert.deepEqual(saved.collectionOptions?.door, plan.collection);
});

test("invalid cached options cannot bypass normal address, contact or collection-window validation", () => {
  assert.equal(courierPlanInput.safeParse({ ...plan, collectionOptions: { pickupPoint: { ...pickupPoint, point: { ...pickupPoint.point, id: "bad" } } } }).success, false);
  assert.equal(courierPlanInput.safeParse({ ...plan, collectionOptions: { door: { ...door, contact: { ...contact, phone: "bad" } } } }).success, false);
  assert.equal(courierPlanInput.safeParse({ ...plan, collectionOptions: { doorSchedule: { ...schedule, after: "17:00", before: "09:00" } } }).success, false);
});
