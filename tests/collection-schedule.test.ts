import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collectionScheduleProblem, collectionRateSchedule, collectionShipmentSchedule, southAfricaToday } from "../lib/shipping/collection-schedule.ts";
import { courierPlanInput } from "../lib/delivery-input.ts";

const schedule = { date: "2026-10-26", after: "09:00", before: "16:00" };
test("collection schedule validation uses South African dates, real calendar dates and complete 08:00–17:00 windows", () => {
  assert.equal(southAfricaToday(Date.parse("2026-10-22T22:30:00Z")), "2026-10-23");
  assert.equal(collectionScheduleProblem(schedule, true, Date.parse("2026-10-22T12:00:00Z")), "");
  for (const invalid of [undefined, { ...schedule, date: "2026-02-30" }, { ...schedule, date: "26/10/2026" }, { ...schedule, after: "" }, { ...schedule, before: "" },
    { ...schedule, after: "9:00" }, { ...schedule, after: "07:59" }, { ...schedule, before: "17:01" }, { ...schedule, after: "16:00" }, { ...schedule, after: "16:01" }]) {
    assert.notEqual(collectionScheduleProblem(invalid), "");
  }
  assert.match(collectionScheduleProblem(schedule, true, Date.parse("2026-10-26T14:00:00Z")), /passed/);
  assert.match(collectionScheduleProblem(schedule, true, Date.parse("2026-10-27T06:00:00Z")), /passed/);
});

test("Bob Go receives a requested quote date and the exact direct-shipment date and window, not just instructions", () => {
  // https://developer.bobgo.co.za/rates/rates/ and /shipments/shipment-create/
  assert.deepEqual(collectionRateSchedule(schedule), { requested_collection_date: "2026-10-26T09:00:00+02:00" });
  assert.deepEqual(collectionShipmentSchedule(schedule), { collection_min_date: "2026-10-26T09:00:00+02:00", collection_after: "09:00:00", collection_before: "16:00:00" });
  assert.deepEqual(collectionRateSchedule(), {}); assert.deepEqual(collectionShipmentSchedule(), {});
  assert.throws(() => collectionShipmentSchedule({ ...schedule, before: "07:00" }));
});

test("saved collection schedules remain order-specific and cannot be attached to locker drop-off", () => {
  const contact = { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" };
  const door = { kind: "door", contact, address: { company: "", line1: "10 Example Street", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" } };
  const plan = { version: 1, collection: door, delivery: door, collectionSchedule: schedule };
  assert.deepEqual(courierPlanInput.parse(plan).collectionSchedule, schedule);
  assert.equal(courierPlanInput.safeParse({ ...plan, collectionSchedule: undefined }).success, true, "Old orders remain readable; quote/booking requires a fresh schedule");
  assert.equal(courierPlanInput.safeParse({ ...plan, collection: { kind: "pickup_point", contact, point: { id: "91001", providerSlug: "demo", name: "DEMO locker" } } }).success, false);
  const source = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
  assert.match(source, /Requested collection:.*collectionScheduleLabel/);
  assert.doesNotMatch(source, /from "\.\.\/lib\/shipping\/collection-schedule"/);
});
