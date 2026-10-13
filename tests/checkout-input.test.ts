import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { checkoutOrderSchema, normalizeCheckoutProvince, normalizeCheckoutPhone, southAfricanProvinces } from "../lib/checkout-input.ts";

const base = {
  checkoutToken: "c4c5b18e-4e64-4d3b-845e-d6432157f723",
  customer: { firstName: "Test", lastName: "Customer", email: "test@example.com", phone: "27766514548" },
  items: [{ sku: "AMINA-LAVENDER-OS", quantity: 1 }],
  fulfilmentMethod: "delivery",
};
const blankAddress = { line1: "", line2: "", suburb: "", city: "", province: "", postalCode: "" };
const validAddress = { line1: " 10 Test Street ", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "7800" };

test("early checkout stages accept delivery without validating or saving hidden address fields", () => {
  for (const stage of ["started", "fulfilment"]) {
    for (const address of [undefined, blankAddress, { city: "C" }, validAddress]) {
      const parsed = checkoutOrderSchema.parse({ ...base, stage, address });
      assert.equal(parsed.address, undefined);
    }
  }
});

test("delivery requires a complete valid address before completing the address or payment stage", () => {
  for (const stage of ["address", "complete"]) {
    for (const address of [undefined, blankAddress, { ...validAddress, suburb: "S" }]) {
      assert.equal(checkoutOrderSchema.safeParse({ ...base, stage, address }).success, false);
    }
    const parsed = checkoutOrderSchema.parse({ ...base, stage, address: validAddress });
    assert.equal(parsed.address?.line1, "10 Test Street");
    assert.equal(parsed.address?.line2, "");
  }
});

test("collection never requires or saves an address at any checkout stage", () => {
  for (const stage of ["started", "fulfilment", "address", "complete"]) {
    const parsed = checkoutOrderSchema.parse({ ...base, stage, fulfilmentMethod: "collection", address: blankAddress });
    assert.equal(parsed.address, undefined);
  }
});

test("all nine provinces accept case and autofill spacing differences, without accepting unknown provinces", () => {
  for (const province of southAfricanProvinces) {
    for (const typed of [province.toLowerCase(), province.toUpperCase(), ` ${province.toLowerCase().replace(/[ -]/g, "  ")} `]) {
      const parsed = checkoutOrderSchema.parse({ ...base, stage: "complete", address: { ...validAddress, province: typed } });
      assert.equal(parsed.address?.province, province);
    }
  }
  assert.equal(normalizeCheckoutProvince(" kwazulu–natal "), "KwaZulu-Natal");
  for (const province of ["Atlantis", "western cap", "Cape Town", "", "WC"]) {
    assert.equal(checkoutOrderSchema.safeParse({ ...base, stage: "complete", address: { ...validAddress, province } }).success, false);
  }
});

test("autofilled contact and address fields preserve names and leading zeros while normalizing email and phone", () => {
  const parsed = checkoutOrderSchema.parse({ ...base, stage: "complete", discountCode: " special ",
    customer: { firstName: " zarina ", lastName: " CUSTOMER ", email: " TEST@EXAMPLE.COM ", phone: " +27 (82) 123-4567 " },
    address: { ...validAddress, city: " cape town ", province: " western cape ", postalCode: " 0081 " } });
  assert.deepEqual(parsed.customer, { firstName: "zarina", lastName: "CUSTOMER", email: "test@example.com", phone: "+27821234567" });
  assert.equal(parsed.address?.province, "Western Cape");
  assert.equal(parsed.address?.city, "cape town"); assert.equal(parsed.address?.postalCode, "0081");
  assert.equal(parsed.discountCode, "SPECIAL");
  assert.equal(normalizeCheckoutPhone("0027 82 123 4567"), "+27821234567");
});

test("address errors name the field instead of exposing a technical string-length error", () => {
  for (const [field, message] of Object.entries({
    line1: "Please enter your street address.", suburb: "Please enter your suburb.",
    city: "Please enter your city.", province: "Please choose your province.",
    postalCode: "Please enter a valid postal code.",
  })) {
    const parsed = checkoutOrderSchema.safeParse({ ...base, stage: "address", address: { ...validAddress, [field]: " " } });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.equal(parsed.error.issues[0].message, message);
  }
});

test("early stages still validate customer details, items and checkout identity", () => {
  for (const override of [{ checkoutToken: "invalid" }, { items: [] }, { customer: { ...base.customer, email: "invalid" } }]) {
    assert.equal(checkoutOrderSchema.safeParse({ ...base, stage: "fulfilment", ...override }).success, false);
  }
});

test("Framer sends an address only once the delivery address step is completed", () => {
  const source = readFileSync(new URL("../framer/CheckoutSlider.tsx", import.meta.url), "utf8");
  const payloadFunction = source.slice(source.indexOf("function checkoutPayload(stage:"), source.indexOf("async function syncOrder"))
    .replace("stage: CheckoutStage", "stage");
  const makePayload = new Function("fulfilmentMethod", "fieldValue", "root", "readCartItems", "getCheckoutToken", "normalizeCheckoutProvince", "normalizeCheckoutPhone", `const readDiscountCode = () => ""; ${payloadFunction}; return checkoutPayload;`);
  const fields: Record<string, string> = { checkoutFullName: "Test", lastName: "Customer", checkoutEmail: "test@example.com", checkoutPhone: "27766514548" };
  const payload = makePayload("delivery", (_root: unknown, key: string) => fields[key] || "", {}, () => base.items, () => base.checkoutToken, normalizeCheckoutProvince, normalizeCheckoutPhone);
  assert.equal(payload("fulfilment").address, undefined);
  assert.throws(() => payload("address"), /Please complete the delivery address/);
  Object.assign(fields, { checkoutStreet: "10 Test Street", suburb: "Test Suburb", checkoutCity: "Cape Town", checkoutProvince: "Western Cape", checkoutPostal: "7800" });
  assert.equal(payload("address").address.line1, "10 Test Street");
  assert.equal(payload("complete").address.postalCode, "7800");
});
