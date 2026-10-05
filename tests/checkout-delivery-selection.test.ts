import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculateShippingQuote } from "../lib/shipping/policy.ts";

const summary = readFileSync(new URL("../framer/CheckoutOrderSummary.tsx", import.meta.url), "utf8");
const slider = readFileSync(new URL("../framer/CheckoutSlider.tsx", import.meta.url), "utf8");

test("checkout summary does not default to delivery when storage is empty, invalid or unavailable", () => {
  const reader = summary.slice(summary.indexOf("function readFulfilmentMethod()"), summary.indexOf("function formatMoney"))
    .replace(": FulfilmentMethod", "");
  const makeReader = new Function("window", "FULFILMENT_KEY", `${reader}; return readFulfilmentMethod;`);
  for (const value of [null, "", "invalid", "to_be_confirmed"]) {
    assert.equal(makeReader({ localStorage: { getItem: () => value } }, "test")(), "to_be_confirmed");
  }
  assert.equal(makeReader(undefined, "test")(), "to_be_confirmed");
  assert.equal(makeReader({ localStorage: { getItem: () => { throw new Error("blocked"); } } }, "test")(), "to_be_confirmed");
  for (const method of ["delivery", "collection"]) {
    assert.equal(makeReader({ localStorage: { getItem: () => method } }, "test")(), method);
  }
});

test("actual storefront totals agree with backend policy before and after choosing fulfilment", () => {
  const calculation = summary.slice(summary.indexOf("    const isCollection ="), summary.indexOf("    const css ="));
  const quote = new Function("subtotal", "fulfilmentMethod", "FREE_DELIVERY_THRESHOLD", "STANDARD_DELIVERY_FEE",
    `${calculation}; return {deliveryFee, total};`);
  for (const subtotal of [0, 420, 1499, 1500, 1800]) {
    for (const method of ["to_be_confirmed", "delivery", "collection"]) {
      const expected = calculateShippingQuote(subtotal, method as "to_be_confirmed" | "delivery" | "collection");
      assert.deepEqual(quote(subtotal, method, 1500, 99), { deliveryFee: expected.deliveryFee, total: expected.total });
    }
  }
  // Switching back from delivery to collection removes the entire fee.
  assert.equal(quote(420, "delivery", 1500, 99).total, 519);
  assert.equal(quote(420, "collection", 1500, 99).total, 420);
});

test("checkout cannot advance past fulfilment until a customer explicitly chooses", () => {
  const payloadFunction = slider.slice(slider.indexOf("function checkoutPayload(stage:"), slider.indexOf("async function syncOrder"))
    .replace("stage: CheckoutStage", "stage");
  const makePayload = new Function("fulfilmentMethod", "fieldValue", "root", "readCartItems", "getCheckoutToken",
    `${payloadFunction}; return checkoutPayload;`);
  const fields: Record<string, string> = { checkoutFullName: "Test", lastName: "Customer", checkoutEmail: "test@example.com", checkoutPhone: "27766514548" };
  const payload = makePayload("to_be_confirmed", (_root: unknown, key: string) => fields[key] || "", {},
    () => [{ sku: "AMINA-LAV-OS", quantity: 1 }], () => "c4c5b18e-4e64-4d3b-845e-d6432157f723");
  assert.equal(payload("started").fulfilmentMethod, "to_be_confirmed");
  for (const stage of ["fulfilment", "address", "complete"]) {
    assert.throws(() => payload(stage), /Please choose delivery or collection/);
  }
});

test("new checkouts ignore old saved choices, but PayFast returns preserve the explicit choice", () => {
  const readSaved = slider.slice(slider.indexOf("    const savedFulfilment = (() => {"), slider.indexOf("    setFulfilmentMethod(savedFulfilment)"));
  const restore = new Function("returnState", "window", "FULFILMENT_KEY", `${readSaved}; return savedFulfilment;`);
  for (const method of [null, "delivery", "collection"]) {
    assert.equal(restore({ payment: "" }, { localStorage: { getItem: () => method } }, "test"), "to_be_confirmed");
  }
  for (const method of ["delivery", "collection"]) {
    assert.equal(restore({ payment: "cancelled" }, { localStorage: { getItem: () => method } }, "test"), method);
  }
  const sliderKey = slider.match(/const FULFILMENT_KEY = "([^"]+)"/)?.[1];
  assert.equal(sliderKey, summary.match(/const FULFILMENT_KEY = "([^"]+)"/)?.[1]);
  assert.notEqual(sliderKey, "moving-modesty-fulfilment-v1");
});
