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
function controller(failPayment = false, width = 390) {
  const names = ["1. Contact details", "2. Fulfilment method", "3. Delivery address", "4. Payment"];
  const inputs = (keys: string[]) => keys.map(name => `<input name="${name}" value="${fields[name as keyof typeof fields]}">`).join("");
  const html = `<form id="checkout">${names.map((name, i) => `<section data-framer-name="${name}"><h2>${name}</h2>${i === 0 ? inputs(Object.keys(fields).slice(0, 4)) : i === 1 ? '<div><div data-framer-name="Delivery">Delivery</div><div data-framer-name="Collection">Collection</div></div>' : i === 2 ? inputs(Object.keys(fields).slice(4)) : ""}</section>`).join("")}</form><div id="summary"></div>`;
  const dom = new JSDOM(html, { url: "https://store.test.invalid/checkout", runScripts: "outside-only" });
  const window = dom.window as any, calls: any[] = [], hosted: any[] = [];
  window.AbortSignal = AbortSignal; window.AbortController = AbortController;
  let viewportWidth = width;
  const mediaListeners = new Set<() => void>();
  window.matchMedia = (query: string) => ({ get matches() { return query.includes("prefers-reduced-motion") || viewportWidth < 1200; },
    addEventListener(_event: string, listener: () => void) { mediaListeners.add(listener); },
    removeEventListener(_event: string, listener: () => void) { mediaListeners.delete(listener); } });
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
  return { dom, window, root, calls, hosted, next, resize(width: number) { viewportWidth = width; mediaListeners.forEach(listener => listener()); },
    get state() { return state; }, close() { cleanup(); dom.window.close(); } };
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

async function summaryHarness(options: { failPayment?: boolean; width?: number } = {}) {
  const page = controller(options.failPayment, options.width);
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : page.window[name], configurable: true, writable: true });
  const exports: any = {};
  runInNewContext(compiled("CheckoutOrderSummary.tsx"), { exports, window: page.window, CustomEvent: page.window.CustomEvent, AbortController, AbortSignal, URLSearchParams,
    require: (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name),
    fetch: () => { throw new Error("Summary must delegate payment, not call a payment API itself."); } });
  const summary = require("react-dom/client").createRoot(page.window.document.getElementById("summary"));
  await act(async () => summary.render(React.createElement(exports.default, {})));
  return { page, doc: page.window.document, async close() {
    await act(async () => summary.unmount()); page.close();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  } };
}

test("mobile shows the complete compact summary without a toggle; final payment review receives focus at the top", async () => {
  const review = await summaryHarness(), { page, doc } = review;
  try {
    assert.equal(doc.querySelector(".mm-checkout-pay"), null, "no disabled payment button above the unfinished steps");
    assert.equal(doc.querySelector(".mm-checkout-security-note"), null);
    assert.equal(doc.querySelector(".mm-checkout-summary-toggle"), null, "no hidden click-to-expand interaction");
    assert.equal(doc.querySelector(".mm-checkout-summary-content").hasAttribute("data-hidden"), false);
    assert.match(doc.querySelector(".mm-checkout-summary-content").textContent, /Amina Tie-Back[\s\S]*Lavender[\s\S]*Qty 1[\s\S]*R420.00[\s\S]*Subtotal[\s\S]*Delivery[\s\S]*Total/);
    assert.equal(doc.querySelector(".mm-checkout-order-image").getAttribute("role"), "img");
    assert.equal(doc.querySelector(".mm-checkout-review-title").style.fontSize, "15px");
    const paymentScrolls: any[] = [];
    doc.querySelector(".mm-checkout-summary").scrollIntoView = (options: any) => paymentScrolls.push(options);
    await act(async () => { await page.next(); page.root.querySelector('[data-framer-name="Collection"]').click(); await page.next(); });
    const button = doc.querySelector(".mm-checkout-pay");
    assert.equal(button.type, "button"); assert.equal(button.disabled, false);
    assert.equal(doc.querySelectorAll(".mm-checkout-pay").length, 1);
    assert.equal(doc.querySelector(".mm-checkout-summary-toggle"), null, "the final review cannot be collapsed");
    assert.equal(doc.querySelector(".mm-checkout-summary-content").hasAttribute("data-hidden"), false);
    assert.equal(doc.querySelector(".mm-checkout-review-title").style.fontSize, "25px");
    assert.equal(doc.querySelector(".mm-checkout-summary").dataset.mmSummaryMode, "payment");
    assert.equal(doc.activeElement, doc.querySelector(".mm-checkout-review-title"), "customers start at the order review, not the pay button");
    assert.equal(paymentScrolls.length, 1); assert.equal(paymentScrolls[0].behavior, "auto"); assert.equal(paymentScrolls[0].block, "start");
    const note = doc.querySelector(".mm-checkout-security-note"); assert.equal(note.tagName, "P"); assert.equal(note.getAttribute("role"), null);
    assert.match(note.textContent, /Secure checkout with PayFast/);
    await act(async () => { button.click(); button.click(); await flush(); });
    assert.equal(page.hosted.length, 1); assert.equal(button.disabled, true); assert.equal(button.textContent, "Opening PayFast…");
    assert.equal(doc.querySelectorAll("form").length, 2, "only the original checkout form and isolated hidden hosted-payment POST exist");
    assert.equal(doc.querySelector(".mm-checkout-edit-details").disabled, true, "editing cannot race a submitted payment");
  } finally { await review.close(); }
});

test("compact mobile/tablet summary keeps every product, image, variant, quantity and line total visible", async () => {
  const review = await summaryHarness(), { page, doc } = review;
  try {
    const items = [{ ...cart[0], quantity: 2, image: "/amina-example.jpg" },
      { id: "HAWA-BLK-S", sku: "HAWA-BLK-S", name: "Hawa Tri-Instant Scarf with a long product name", colour: "Black", size: "Small", quantity: 1, price: 450, image: "/hawa-example.jpg" }];
    await act(async () => { page.window.localStorage.setItem("moving-modesty-cart-v1", JSON.stringify(items)); page.window.dispatchEvent(new page.window.CustomEvent("moving-modesty-cart-updated")); });
    for (const width of [320, 390, 810, 1024, 1199]) {
      await act(async () => page.resize(width));
      assert.equal(doc.querySelector(".mm-checkout-summary").dataset.mmSummaryMode, "compact");
      assert.equal(doc.querySelector(".mm-checkout-summary-toggle"), null);
      assert.equal(doc.querySelector(".mm-checkout-summary-content").hasAttribute("data-hidden"), false);
      const lines = [...doc.querySelectorAll(".mm-checkout-order-item")];
      assert.equal(lines.length, 2, "larger carts are not truncated to one product");
      assert.match(lines[0].textContent, /Amina Tie-Back[\s\S]*Lavender[\s\S]*One size fits all[\s\S]*Qty 2[\s\S]*R840.00/);
      assert.match(lines[1].textContent, /Hawa Tri-Instant Scarf with a long product name[\s\S]*Black[\s\S]*Small[\s\S]*Qty 1[\s\S]*R450.00/);
      assert.equal(lines[0].querySelector("img").getAttribute("src"), "/amina-example.jpg");
      assert.equal(lines[1].querySelector("img").getAttribute("alt"), items[1].name);
      assert.equal(lines[1].querySelector("h3").style.fontSize, "13px");
      assert.match(doc.querySelector(".mm-checkout-summary-content").textContent, /TotalR1290.00/);
      assert.equal(doc.querySelector(".mm-checkout-pay"), null);
    }
    assert.equal(page.calls.length, 0, "rendering a summary does not create an order or start payment");
  } finally { await review.close(); }
});

test("tablet also defers payment until all required delivery fields are valid", async () => {
  const review = await summaryHarness({ width: 1024 }), { page, doc } = review;
  try {
    assert.equal(doc.querySelector(".mm-checkout-summary").dataset.mmSummaryMode, "compact");
    const phone = page.root.querySelector('[name="checkoutPhone"]'); phone.value = "";
    await act(async () => page.next()); assert.equal(page.root.dataset.mmActiveStep, "1");
    assert.equal(doc.querySelector(".mm-checkout-pay"), null);
    phone.value = "0821234567";
    await act(async () => page.next());
    await act(async () => page.next()); assert.equal(page.root.dataset.mmActiveStep, "2", "a fulfilment method is required");
    await act(async () => { page.root.querySelector('[data-framer-name="Delivery"]').click(); await page.next(); });
    const postal = page.root.querySelector('[name="checkoutPostal"]'); postal.value = "";
    await act(async () => page.next()); assert.equal(page.root.dataset.mmActiveStep, "3");
    assert.equal(doc.querySelector(".mm-checkout-pay"), null);
    postal.value = "0081";
    await act(async () => page.next());
    assert.equal(page.root.dataset.mmActiveStep, "4");
    assert.equal(doc.querySelector(".mm-checkout-summary").dataset.mmSummaryMode, "payment");
    assert.equal(doc.querySelector(".mm-checkout-summary-content").hasAttribute("data-hidden"), false);
    assert.equal(doc.querySelector(".mm-checkout-pay").disabled, false);
    assert.equal(page.hosted.length, 0, "reaching review does not submit a payment");
  } finally { await review.close(); }
});

test("payment errors stay visible inside the standalone review; Edit details preserves fields and re-hides payment", async () => {
  const review = await summaryHarness({ failPayment: true }), { page, doc } = review;
  try {
    await act(async () => { await page.next(); page.root.querySelector('[data-framer-name="Collection"]').click(); await page.next(); });
    await act(async () => { doc.querySelector(".mm-checkout-pay").click(); await flush(); });
    assert.match(doc.querySelector(".mm-checkout-review-message").textContent, /Payment unavailable.*TEST-REF/);
    assert.equal(doc.querySelector(".mm-checkout-pay").disabled, false);
    const callsBefore = page.calls.length;
    await act(async () => { doc.querySelector(".mm-checkout-edit-details").click(); await flush(); });
    assert.equal(page.root.dataset.mmActiveStep, "1"); assert.equal(doc.querySelector(".mm-checkout-pay"), null);
    assert.equal(page.calls.length, callsBefore, "editing alone does not save or pay");
    for (const [name, value] of Object.entries(fields)) assert.equal(page.root.querySelector(`[name="${name}"]`).value, value);
    await act(async () => { await page.next(); await page.next(); });
    assert.equal(doc.querySelectorAll(".mm-checkout-pay").length, 1);
    assert.equal(doc.querySelector(".mm-checkout-review-message"), null);
  } finally { await review.close(); }
});

test("desktop keeps its expanded summary and responsive resizing never collapses the final review or duplicates Pay", async () => {
  const review = await summaryHarness({ width: 1440 }), { page, doc } = review;
  try {
    assert.equal(doc.querySelector(".mm-checkout-summary").dataset.mmSummaryMode, "desktop");
    assert.equal(doc.querySelector(".mm-checkout-summary-toggle"), null);
    assert.equal(doc.querySelector(".mm-checkout-pay"), null);
    await act(async () => { await page.next(); page.root.querySelector('[data-framer-name="Collection"]').click(); await page.next(); });
    assert.equal(doc.querySelector(".mm-checkout-edit-details"), null);
    for (const width of [1024, 768, 390, 1440, 1199]) {
      await act(async () => page.resize(width));
      assert.equal(doc.querySelectorAll(".mm-checkout-pay").length, 1);
      assert.equal(doc.querySelector(".mm-checkout-summary-content").hasAttribute("data-hidden"), false);
      assert.equal(doc.querySelector(".mm-checkout-summary-toggle"), null);
      assert.equal(doc.querySelector(".mm-checkout-summary").dataset.mmSummaryMode, width < 1200 ? "payment" : "desktop");
    }
  } finally { await review.close(); }
});
