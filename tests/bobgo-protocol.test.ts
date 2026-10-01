import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fingerprint, parcelInput, parcelPayload, parseLocation, parseRates, signQuote, submissionIsBooked, verifyQuote, type ApprovedQuote } from "../lib/integrations/bobgo/protocol.ts";

const parcel = { weightGrams: 412, lengthCm: 25, widthCm: 20.5, heightCm: 3.5 };
const address = { company: "", street_address: "Test drop-off", local_area: "", city: "Cape Town", zone: "Western Cape", country: "ZA", code: "7800" };
const quote: ApprovedQuote = { version: 1, orderNumber: "MM-TEST", fingerprint: fingerprint(parcel), expires: 1000,
  environment: "production", parcel, collectionAddress: address, declaredValue: 870,
  providerSlug: "ie", providerName: "Internet Express", serviceCode: "BOX", serviceName: "Locker to door", amount: 99.15 };

test("courier approvals are signed, tamper-proof and expire", () => {
  const token = signQuote(quote, "test-secret-not-a-real-credential");
  assert.deepEqual(verifyQuote(token, "test-secret-not-a-real-credential", 999), quote);
  assert.throws(() => verifyQuote(token, "wrong-secret", 999));
  assert.throws(() => verifyQuote(token, "test-secret-not-a-real-credential", 1000), /expired/);
  const [payload, signature] = token.split(".");
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), amount: 1 })).toString("base64url");
  assert.throws(() => verifyQuote(`${altered}.${signature}`, "test-secret-not-a-real-credential", 999), /Invalid/);
  assert.throws(() => verifyQuote("malformed", "test-secret-not-a-real-credential", 0));
});

test("parcels require positive real measurements and convert grams to kilograms", () => {
  assert.deepEqual(parcelInput.parse(parcel), parcel);
  assert.equal(parcelPayload(parcel, "MM-TEST")[0].submitted_weight_kg, 0.412);
  assert.equal(parcelPayload(parcel, "MM-TEST")[0].submitted_width_cm, 20.5);
  for (const invalid of [{ ...parcel, weightGrams: 0 }, { ...parcel, heightCm: -1 }, { ...parcel, widthCm: 20.555 }, { ...parcel, weightGrams: 40000 }]) assert.equal(parcelInput.safeParse(invalid).success, false);
});

test("only successful services returned by the configured provider can be approved", () => {
  const response = { provider_rate_requests: [
    { provider_slug: "other", status: "success", responses: [{ status: "success", service_level_code: "WRONG", rate_amount: 1 }] },
    { provider_slug: "ie", provider_name: "Internet Express", status: "success", responses: [
      { status: "success", service_level_code: "BOX2", service_level: { name: "Box 2" }, rate_amount: "100.50" },
      { status: "failed", service_level_code: "BAD", rate_amount: 2 },
      { status: "success", service_level_code: "BOX1", rate_amount: 90 },
      { status: "success", service_level_code: "ZERO", rate_amount: 0 },
    ] },
  ] };
  assert.deepEqual(parseRates(response, "ie").map(rate => [rate.serviceCode, rate.amount]), [["BOX1", 90], ["BOX2", 100.5]]);
  assert.deepEqual(parseRates({ provider_rate_requests: [] }, "ie"), []);
});

test("pickup lookup never substitutes another provider, inactive location or incomplete address", () => {
  const location = { id: 1156, provider_slug: "ie", active: true, type: "locker", name: "Constantia Emporium", address };
  assert.deepEqual(parseLocation({ locations: [location] }, "1156", "ie"), { name: "Constantia Emporium", address });
  assert.throws(() => parseLocation({ locations: [location] }, "public-listing-number", "ie"));
  assert.throws(() => parseLocation({ locations: [location] }, "1156", "another-provider"));
  assert.throws(() => parseLocation([{ ...location, active: false }], "1156", "ie"));
  assert.throws(() => parseLocation([{ ...location, address: { ...address, code: "" } }], "1156", "ie"));
  const sample = { ...location, name: "Shiplogic Locker Test", address: "Menlyn Central Towers, 125 Dallas Avenue, Menlyn, Pretoria, 0181, Gauteng, ZA", compartment_errors: [] };
  assert.deepEqual(parseLocation([sample], "1156", "ie").address, { company: sample.name, street_address: "Menlyn Central Towers, 125 Dallas Avenue", local_area: "Menlyn", city: "Pretoria", code: "0181", zone: "Gauteng", country: "ZA" });
  assert.throws(() => parseLocation([{ ...sample, compartment_errors: ["no_available_compartments"] }], "1156", "ie"));
  assert.doesNotThrow(() => parseLocation([{ ...sample, compartment_errors: ["no_available_compartments"] }], "1156", "ie", false));
  assert.throws(() => parseLocation([{ ...sample, type: "door" }], "1156", "ie"));
});

test("only a confirmed locker-to-door shipment unlocks handover", () => {
  const shipment = { id: 1, tracking_reference: "TEST", submission_status: "success", collection_location_type: "locker", delivery_location_type: "door" };
  assert.equal(submissionIsBooked(shipment), true);
  for (const submission_status of ["pending", "failed", "failed-will-retry", undefined]) assert.equal(submissionIsBooked({ ...shipment, submission_status }), false);
  assert.equal(submissionIsBooked({ ...shipment, delivery_location_type: "locker" }), false);
  assert.equal(submissionIsBooked({ ...shipment, tracking_reference: "" }), false);
});

test("booking stays server-side, commits a durable lock before the chargeable request and never auto-dispatches", () => {
  const source = readFileSync(new URL("../lib/integrations/bobgo/shipping.ts", import.meta.url), "utf8");
  const booking = source.slice(source.indexOf("export async function bookCourierShipment"), source.indexOf("async function saveShipmentResponse"));
  assert.ok(booking.indexOf('status: "booking"') < booking.indexOf('bobGoRequest("/shipments", body)'));
  assert.match(booking, /\.for\("update"\)/);
  assert.match(booking, /verifyQuote\(quoteToken, secret\(\)\)/);
  assert.doesNotMatch(booking, /delivery_pickup_point_location_id|status: "dispatched"/);
  assert.match(source, /shipment\?\.provider !== `bobgo-\$\{config.environment\}`/);
  const route = readFileSync(new URL("../app/api/admin/orders/[orderNumber]/book-shipment/route.ts", import.meta.url), "utf8");
  assert.match(route, /getRequestAdmin/);
  assert.match(route, /confirm !== true/);
  const component = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /BOBGO_API_TOKEN|Bearer\s+[a-f0-9]{32}/);
  assert.match(component, /Confirm LIVE courier booking/);
});
