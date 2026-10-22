import assert from "node:assert/strict";
import test from "node:test";
import { linkedCollectionDateFields, linkedCollectionDateMatches, linkedCollectionInstructions, linkedCollectionProblem, linkedCollectionShipmentMatches } from "../lib/integrations/bobgo/linked-collection.ts";
import { getLinkedBookingConfiguration } from "../lib/integrations/bobgo/linked-booking-policy.ts";
import { getOrderSyncConfiguration } from "../lib/integrations/bobgo/order-sync-policy.ts";
import { linkedOrderUpdate, linkedFulfillmentPayload } from "../lib/integrations/bobgo/linked-booking-policy.ts";
import type { CourierPlan } from "../lib/delivery-input.ts";
import type { ApprovedQuote, CourierBookingSnapshot } from "../lib/integrations/bobgo/protocol.ts";
import type { BobGoOrderPayload } from "../lib/integrations/bobgo/order-sync-policy.ts";

const schedule = { date: "2099-07-16", after: "09:00", before: "16:00" };
test("linked scheduling uses the official preset date and sends hours only as an explicitly preferred driver note", () => {
  assert.deepEqual(linkedCollectionDateFields(schedule), { requested_collection_date: "2099-07-16T09:00:00+02:00" });
  assert.deepEqual(linkedCollectionDateFields(), {});
  const note = linkedCollectionInstructions("Ring the bell.", schedule);
  assert.match(note, /^Ring the bell\.\nPreferred collection hours: 2099-07-16, 09:00-16:00 SAST\. Requested, not a guaranteed time slot\.$/);
  assert.equal(linkedCollectionInstructions(note, schedule), note, "Never duplicate the generated preference");
  assert.equal(linkedCollectionInstructions("Drop-off note"), "Drop-off note");
  assert.throws(() => linkedCollectionInstructions("x".repeat(1000), schedule), /Shorten/);
  assert.throws(() => linkedCollectionDateFields({ ...schedule, before: "08:00" }));
  assert.equal(getOrderSyncConfiguration().enabled, false);
  assert.equal(getLinkedBookingConfiguration().enabled, false);
});

test("both linked request builders preserve the same date and driver note without inventing structured time slots", () => {
  const snapshot = { collection: {}, delivery: {}, collectionSchedule: schedule, collectionInstructions: linkedCollectionInstructions("", schedule), deliveryInstructions: "",
    linkedOrder: { remoteOrderId: "123", collectionAddressBookId: "45" } } as CourierBookingSnapshot;
  const update = linkedOrderUpdate("123", {} as BobGoOrderPayload, snapshot, { weightGrams: 183, lengthCm: 25, widthCm: 20, heightCm: 3 }, "45");
  const quote = { version: 3, declaredValue: 0, deliverySnapshot: snapshot, providerSlug: "example", serviceCode: "ECO" } as ApprovedQuote;
  const fulfillment = linkedFulfillmentPayload(quote, "TEST-NOT-SUBMITTED");
  for (const request of [update, fulfillment]) {
    assert.equal(request.order_fulfillment_presets.requested_collection_date, "2099-07-16T09:00:00+02:00");
    assert.equal(request.order_fulfillment_presets.instructions_collection, snapshot.collectionInstructions);
    for (const field of ["collection_after", "collection_before", "collection_min_date"]) assert.equal(field in request.order_fulfillment_presets, false);
  }
});

test("requested dates are compared in South African time and shipment confirmation also requires the driver note", () => {
  for (const value of [schedule.date, "2099-07-16T00:00:00+02:00", "2099-07-15T22:00:00Z", "2099-07-16T07:00:00Z"]) assert.equal(linkedCollectionDateMatches(value, schedule), true);
  for (const value of [undefined, null, "16/07/2099", "2099-07-16T09:00:00", "2099-07-15T21:59:59Z", "2099-07-16T22:00:00Z"]) assert.equal(linkedCollectionDateMatches(value, schedule), false);
  const instructions = linkedCollectionInstructions("Gate code is on the parcel.", schedule);
  assert.equal(linkedCollectionShipmentMatches({ collection_min_date: schedule.date, instructions_collection: instructions.replace("\n", "\r\n") }, schedule, instructions), true);
  assert.equal(linkedCollectionShipmentMatches({ collection_min_date: schedule.date, instructions_collection: "Gate code is on the parcel." }, schedule, instructions), false);
  assert.equal(linkedCollectionShipmentMatches({}, undefined, "Legacy note"), true);
});

test("linked collection timing cannot be missing, expired or applied to a drop-off", () => {
  const door = { kind: "door" } as CourierPlan["collection"];
  const plan = { collection: door, collectionSchedule: schedule } as CourierPlan;
  assert.equal(linkedCollectionProblem(plan, Date.parse("2099-07-15T12:00:00Z")), "");
  assert.match(linkedCollectionProblem(plan, Date.parse("2099-07-16T14:00:00Z")), /passed/);
  assert.match(linkedCollectionProblem({ ...plan, collectionSchedule: undefined }, Date.now()), /Choose/);
  const pickup = { ...plan, collection: { kind: "pickup_point" } } as CourierPlan;
  assert.match(linkedCollectionProblem(pickup, Date.now()), /do not apply/);
  assert.equal(linkedCollectionProblem({ ...pickup, collectionSchedule: undefined }, Date.now()), "");
});
