/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated browser harness with all network requests intercepted. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { normalizeCheckoutProvince, southAfricanProvinces } from "../lib/checkout-input.ts";

const require = createRequire(import.meta.url);
const PAY = "moving-modesty-checkout-pay", STATE = "moving-modesty-checkout-payment-state";
const cart = [{ id: "AMINA-LAV-OS", sku: "AMINA-LAV-OS", name: "Amina Tie-Back", colour: "Lavender", size: "One size fits all", quantity: 1, price: 420, image: "" }];
const fields = { checkoutFullName: "TEST", lastName: "Customer", checkoutEmail: "test@example.com", checkoutPhone: "0821234567",
  checkoutStreet: "10 Test Street", suburb: "Test Suburb", checkoutCity: "Cape Town", checkoutProvince: "Western Cape", checkoutPostal: "0081" };
function compiled(file: string) {
  return ts.transpileModule(readFileSync(new URL(`../framer/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
const flush = () => new Promise(resolve => setTimeout(resolve, 10));
function controller(failPayment = false) {
  const names = ["1. Contact details", "2. Fulfilment method", "3. Delivery address", "4. Payment"];
  const inputs = (keys: string[]) => keys.map(name => `<input name="${name}" value="${fields[name as keyof typeof fields]}">`).join("");
  const html = `<form id="checkout">${names.map((name, i) => `<section data-framer-name="${name}"><h2>${name}</h2>${i === 0 ? inputs(Object.keys(fields).slice(0, 4)) : i === 1 ? '<div><div data-framer-name="Delivery">Delivery</div><div data-framer-name="Collection">Collection</div></div>' : i === 2 ? inputs(Object.keys(fields).slice(4)) : ""}</section>`).join("")}</form><div id="summary"></div>`;
  const dom = new JSDOM(html, { url: "https://store.test.invalid/checkout", runScripts: "outside-only" });
  const window = dom.window as any, calls: any[] = [], hosted: any[] = [];
  window.AbortSignal = AbortSignal; window.AbortController = AbortController;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {}; window.HTMLElement.prototype.getAnimations = () => [];
  window.HTMLFormElement.prototype.submit = function () { hosted.push({ action: this.action, method: this.method }); };
  window.localStorage.setItem("moving-modesty-cart-v1", JSON.stringify(cart));
  window.fetch = async (url: string, options: any) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith("/api/checkout/orders")) return Response.json({ order: { orderNumber: "MM-TEST", total: body.fulfilmentMethod === "delivery" ? 519 : 420 } });
    assert.match(url, /\/api\/payments\/payfast\/checkout$/);
    assert.deepEqual(Object.keys(body).sort(), ["checkoutToken", "orderNumber"]);
    return failPayment ? Response.json({ error: "Payment unavailable", errorRef: "TEST-REF" }, { status: 503 })
      : Response.json({ payment: { action: "https://www.payfast.co.za/eng/process", fields: { m_payment_id: "MM-TEST" } } });
  };
  window.require = require; window.exports = {};
  window.eval(`${compiled("CheckoutSlider.tsx")}\nexports.testSetup = setupSlider;`);
  const root = window.document.getElementById("checkout");
  let state: any;
  window.addEventListener(STATE, (event: any) => { state = event.detail; });
  const cleanup = window.exports.testSetup(root);
  const next = async () => { root.querySelector(`[data-mm-checkout-step="${root.dataset.mmActiveStep}"] .mm-checkout-next`).click(); await flush(); };
  return { dom, window, root, calls, hosted, next, get state() { return state; }, close() { cleanup(); dom.window.close(); } };
}

test("the summary action preserves the collection flow and submits one hosted PayFast POST, never a duplicate", async () => {
  const page = controller();
  try {
    assert.equal(page.state.disabled, true);
    page.window.dispatchEvent(new page.window.CustomEvent(PAY)); await flush();
    assert.equal(page.calls.length, 0, "payment cannot bypass earlier checkout steps");
    await page.next();
    page.root.querySelector('[data-framer-name="Collection"]').click(); await page.next();
    assert.equal(page.root.dataset.mmActiveStep, "4"); assert.equal(page.state.disabled, false);
    assert.equal(page.root.querySelector('[data-mm-checkout-step="4"] .mm-checkout-next'), null, "no duplicate payment button remains under the form");
    page.window.dispatchEvent(new page.window.CustomEvent(PAY)); page.window.dispatchEvent(new page.window.CustomEvent(PAY)); await flush();
    assert.equal(page.calls.filter(call => call.body.stage === "complete").length, 1);
    assert.equal(page.calls.filter(call => call.url.endsWith("/api/payments/payfast/checkout")).length, 1);
    assert.deepEqual(page.hosted, [{ action: "https://www.payfast.co.za/eng/process", method: "post" }]);
    assert.equal(page.state.label, "Opening PayFast…"); assert.equal(page.state.disabled, true);
    page.window.dispatchEvent(new page.window.CustomEvent(PAY)); await flush(); assert.equal(page.hosted.length, 1);
  } finally { page.close(); }
});

test("delivery still requires a valid postal code; a failed PayFast request restores the same summary retry action", async () => {
  const page = controller(true);
  try {
    await page.next(); page.root.querySelector('[data-framer-name="Delivery"]').click(); await page.next();
    assert.equal(page.root.dataset.mmActiveStep, "3");
    const postal = page.root.querySelector('[name="checkoutPostal"]'); postal.value = "ABC";
    await page.next(); assert.equal(page.root.dataset.mmActiveStep, "3"); assert.equal(page.state.disabled, true);
    postal.value = "0081"; await page.next(); assert.equal(page.root.dataset.mmActiveStep, "4");
    page.window.dispatchEvent(new page.window.CustomEvent(PAY)); await flush();
    assert.equal(page.hosted.length, 0); assert.equal(page.state.label, "Pay securely"); assert.equal(page.state.disabled, false);
    assert.match(page.root.textContent, /Payment unavailable.*TEST-REF/);
    assert.equal(page.calls.find(call => call.body.stage === "complete").body.address.postalCode, "0081");
  } finally { page.close(); }
});

test("silent browser autofill is read at Continue and Pay securely, with case-insensitive provinces and leading-zero postcodes", async () => {
  const page = controller();
  try {
    // Deliberately do not fire input/change: some browsers autofill silently.
    const fill = (name: string, value: string) => { page.root.querySelector(`[name="${name}"]`).value = value; };
    fill("checkoutFullName", " zarina "); fill("lastName", " CUSTOMER ");
    fill("checkoutEmail", "TEST@EXAMPLE.COM"); fill("checkoutPhone", " +27 (82) 123-4567 ");
    await page.next(); assert.equal(page.root.dataset.mmActiveStep, "2");
    page.root.querySelector('[data-framer-name="Delivery"]').click(); await page.next();
    fill("checkoutStreet", " 10 test street "); fill("suburb", " test suburb ");
    fill("checkoutCity", " cape town "); fill("checkoutProvince", " western  cape "); fill("checkoutPostal", " 0081 ");
    await page.next(); assert.equal(page.root.dataset.mmActiveStep, "4");
    // Autofill can also replace fields on the payment step. Use their current
    // values, rather than an earlier saved draft or a React change-event cache.
    fill("checkoutEmail", "UPDATED@EXAMPLE.COM"); fill("checkoutPhone", "0027 83 765 4321");
    fill("checkoutProvince", "KWAZULU–NATAL");
    page.window.dispatchEvent(new page.window.CustomEvent(PAY)); await flush();
    const payload = page.calls.find(call => call.body.stage === "complete").body;
    assert.deepEqual(payload.customer, { firstName: "zarina", lastName: "CUSTOMER", email: "updated@example.com", phone: "+27837654321" });
    assert.deepEqual(payload.address, { line1: "10 test street", line2: "", suburb: "test suburb", city: "cape town", province: "KwaZulu-Natal", postalCode: "0081" });
    assert.equal(page.hosted.length, 1);
    const autocomplete = { checkoutFullName: "given-name", lastName: "family-name", checkoutEmail: "email", checkoutPhone: "tel",
      checkoutStreet: "address-line1", suburb: "address-level3", checkoutCity: "address-level2", checkoutProvince: "address-level1", checkoutPostal: "postal-code" };
    for (const [name, token] of Object.entries(autocomplete)) assert.equal(page.root.querySelector(`[name="${name}"]`).autocomplete, token);
    assert.equal(page.root.querySelector('[name="checkoutPostal"]').type, "text");
    assert.equal(page.root.querySelector('[name="checkoutEmail"]').getAttribute("autocapitalize"), "none");
  } finally { page.close(); }
});

test("frontend province matching agrees with the server and clears stale errors after silent autofill correction", async () => {
  const page = controller();
  try {
    await page.next(); page.root.querySelector('[data-framer-name="Delivery"]').click(); await page.next();
    const province = page.root.querySelector('[name="checkoutProvince"]');
    province.value = "Atlantis"; await page.next();
    assert.equal(page.root.dataset.mmActiveStep, "3"); assert.equal(province.validity.customError, true);
    for (const canonical of southAfricanProvinces) {
      for (const typed of [canonical.toLowerCase(), canonical.toUpperCase(), ` ${canonical.toLowerCase().replace(/[ -]/g, "  ")} `]) {
        province.value = typed; province.dispatchEvent(new page.window.Event("input", { bubbles: true }));
        assert.equal(province.validity.customError, false, typed); assert.equal(normalizeCheckoutProvince(typed), canonical);
      }
    }
    province.value = "Atlantis"; province.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    assert.equal(province.validity.customError, true);
    province.value = "western cape"; await page.next();
    assert.equal(page.root.dataset.mmActiveStep, "4"); assert.equal(province.validity.customError, false);
    assert.equal(page.calls.find(call => call.body.stage === "address").body.address.province, "Western Cape");
    const callsBefore = page.calls.length;
    const phone = page.root.querySelector('[name="checkoutPhone"]'); phone.value = "invalid";
    page.window.dispatchEvent(new page.window.CustomEvent(PAY)); await flush();
    assert.equal(page.root.dataset.mmActiveStep, "1"); assert.equal(page.hosted.length, 0); assert.equal(page.calls.length, callsBefore);
    phone.value = "082 123 4567"; await page.next(); assert.equal(page.root.dataset.mmActiveStep, "2");
  } finally { page.close(); }
});

test("case and autofill fixes do not make blank or invalid values valid, and cleanup restores input attributes", async () => {
  const page = controller();
  const email = page.root.querySelector('[name="checkoutEmail"]');
  try {
    const first = page.root.querySelector('[name="checkoutFullName"]'); first.value = "   ";
    await page.next(); assert.equal(page.root.dataset.mmActiveStep, "1"); assert.equal(page.calls.length, 0);
    first.value = "test"; email.value = "invalid"; await page.next(); assert.equal(page.calls.length, 0);
    email.value = "TEST@EXAMPLE.COM"; await page.next(); assert.equal(page.root.dataset.mmActiveStep, "2");
  } finally { page.close(); }
  assert.equal(email.getAttribute("autocomplete"), null); assert.equal(email.getAttribute("autocapitalize"), null);
  assert.equal(email.getAttribute("spellcheck"), null); assert.equal(email.validity.customError, false);
});

test("controller cleanup disconnects the external action and removes its request listener", async () => {
  const page = controller();
  await page.next(); page.root.querySelector('[data-framer-name="Collection"]').click(); await page.next();
  page.close(); assert.equal(page.state.connected, false); assert.equal(page.state.disabled, true);
});

test("mobile summary keeps one real payment button outside its collapsed content, with plain security reassurance", async () => {
  const page = controller();
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : page.window[name], configurable: true, writable: true });
  const exports: any = {};
  runInNewContext(compiled("CheckoutOrderSummary.tsx"), { exports, window: page.window, CustomEvent: page.window.CustomEvent, AbortController, AbortSignal, URLSearchParams,
    require: (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name),
    fetch: () => { throw new Error("Summary must delegate payment, not call a payment API itself."); } });
  const root = require("react-dom/client").createRoot(page.window.document.getElementById("summary"));
  try {
    await act(async () => root.render(React.createElement(exports.default, {})));
    const doc = page.window.document, button = doc.querySelector(".mm-checkout-pay");
    const paymentScrolls: any[] = [];
    button.getBoundingClientRect = () => ({ top: 1200, bottom: 1257, height: 57 });
    button.scrollIntoView = (options: any) => paymentScrolls.push(options);
    assert.equal(button.type, "button"); assert.equal(button.disabled, true);
    assert.equal(doc.querySelector(".mm-checkout-summary-content").dataset.hidden, "true");
    assert.equal(button.closest(".mm-checkout-summary-content"), null);
    const note = doc.querySelector(".mm-checkout-security-note"); assert.equal(note.tagName, "P"); assert.equal(note.getAttribute("role"), null);
    assert.match(note.textContent, /Secure checkout with PayFast/);
    await act(async () => { await page.next(); page.root.querySelector('[data-framer-name="Collection"]').click(); await page.next(); });
    assert.equal(button.disabled, false); assert.equal(doc.querySelectorAll(".mm-checkout-pay").length, 1);
    assert.equal(doc.activeElement, button, "payment action receives focus when the final step is ready");
    assert.equal(paymentScrolls.length, 1, "an offscreen payment action is brought into view once");
    assert.equal(paymentScrolls[0].behavior, "auto"); assert.equal(paymentScrolls[0].block, "center");
    await act(async () => { button.click(); button.click(); await flush(); });
    assert.equal(page.hosted.length, 1); assert.equal(button.disabled, true); assert.equal(button.textContent, "Opening PayFast…");
    assert.equal(doc.querySelectorAll("form").length, 2, "only the original checkout form and isolated hidden hosted-payment POST exist");
  } finally {
    await act(async () => root.unmount()); page.close();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
