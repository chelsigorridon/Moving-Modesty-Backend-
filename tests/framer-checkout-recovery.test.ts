/* eslint-disable @typescript-eslint/no-explicit-any -- The DOM harness executes transpiled Framer code in a separate runtime. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const CART = "moving-modesty-cart-v1";
const TOKEN = "moving-modesty-checkout-token-v1";
const DRAFT = "moving-modesty-checkout-draft-v1";
const token = "c4c5b18e-4e64-4d3b-845e-d6432157f723";
const fields = { checkoutFullName: "Test", lastName: "Customer", checkoutEmail: "test@example.com", checkoutPhone: "0821234567",
  checkoutStreet: "10 Test Street", suburb: "Test Suburb", checkoutCity: "Cape Town", checkoutProvince: "Western Cape", checkoutPostal: "0081" };
const cart = [{ id: "AMINA-LAV-OS", sku: "AMINA-LAV-OS", name: "Amina Tie-Back", colour: "Lavender", size: "One size fits all", quantity: 1, price: 420 }];

function load(dom: JSDOM, file: string, exposed: string) {
  const window = dom.window as any;
  window.require = (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: { String: 1, Link: 2 } } : require(name);
  window.exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../framer/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  window.eval(`${code}\nexports.harness = { ${exposed} };`);
  return window.exports.harness;
}

async function checkout(paymentStatus: string, options: { processing?: boolean; fail?: boolean; changedCart?: boolean; noDraft?: boolean; changedToken?: boolean } = {}) {
  const names = ["1. Contact details", "2. Fulfilment method", "3. Delivery address", "4. Payment"];
  const inputs = (keys: string[]) => keys.map(name => `<input name="${name}">`).join("");
  const html = `<form id="checkout">${names.map((name, i) => `<section data-framer-name="${name}"><h2>${name}</h2>${i === 0 ? inputs(Object.keys(fields).slice(0, 4)) : i === 1 ? '<div><div data-framer-name="Delivery">Delivery</div><div data-framer-name="Collection">Collection</div></div>' : i === 2 ? inputs(Object.keys(fields).slice(4)) : ""}</section>`).join("")}</form>`;
  const dom = new JSDOM(html, { url: `https://holistic-brand-492217.framer.app/checkout?payment=${options.processing ? "processing" : "cancelled"}&order=MM-TEST`, runScripts: "outside-only" });
  const window = dom.window as any;
  window.AbortSignal = AbortSignal;
  window.AbortController = AbortController;
  window.matchMedia = () => ({ matches: true });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.getAnimations = () => [];
  window.localStorage.setItem(CART, JSON.stringify(options.changedCart ? [{ ...cart[0], quantity: 2 }] : cart));
  window.localStorage.setItem(TOKEN, token);
  if (!options.noDraft) window.sessionStorage.setItem(DRAFT, JSON.stringify({ token, orderReference: "MM-TEST", fields, fulfilmentMethod: "delivery", cart, savedAt: Date.now() }));
  window.fetch = async (url: string) => {
    assert.match(url, /\/api\/checkout\/session$/);
    if (options.changedToken) window.localStorage.setItem(TOKEN, "3f1ad40c-9fe5-44f4-aaba-98f567b32b70");
    if (options.fail) return Response.json({ error: "Status temporarily unavailable" }, { status: 503 });
    return Response.json({ session: { orderNumber: "MM-TEST", status: paymentStatus === "paid" ? "confirmed" : "new", paymentStatus,
      fulfilmentMethod: "delivery", customer: { firstName: "Test", lastName: "Customer", email: "test@example.com", phone: "0821234567" },
      address: { line1: "10 Test Street", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "0081" }, items: cart } });
  };
  const { setupSlider } = load(dom, "CheckoutSlider.tsx", "setupSlider");
  const root = window.document.getElementById("checkout");
  const cleanup = setupSlider(root);
  await new Promise(resolve => setTimeout(resolve, 20));
  return { dom, window, root, close() { cleanup(); dom.window.close(); } };
}

test("cancelled payment restores all fields and offers retry, including proper autofill attributes", async () => {
  const page = await checkout("failed");
  try {
    for (const [name, value] of Object.entries(fields)) assert.equal(page.root.querySelector(`[name="${name}"]`).value, value);
    assert.equal(page.root.dataset.mmActiveStep, "4");
    assert.equal(page.root.querySelector('[name="checkoutEmail"]').autocomplete, "email");
    const postal = page.root.querySelector('[name="checkoutPostal"]');
    assert.equal(postal.autocomplete, "postal-code");
    assert.equal(postal.inputMode, "numeric");
    assert.equal(postal.value, "0081");
    postal.value = "ABC";
    assert.equal(postal.checkValidity(), false);
    assert.match(page.root.querySelector('[data-mm-checkout-step="4"] button.mm-checkout-next').textContent, /Pay securely/);
    assert.notEqual(page.window.localStorage.getItem(CART), null);
  } finally { page.close(); }
});

test("missing browser draft can be restored only through the token-protected server session", async () => {
  const page = await checkout("failed", { noDraft: true });
  try {
    assert.equal(page.root.querySelector('[name="checkoutFullName"]').value, "Test");
    assert.equal(page.root.querySelector('[name="checkoutPostal"]').value, "0081");
    assert.equal(page.root.dataset.mmActiveStep, "4");
  } finally { page.close(); }
});

test("a processing URL with unavailable verification cannot clear the cart or claim payment success", async () => {
  const page = await checkout("pending", { processing: true, fail: true });
  try {
    assert.notEqual(page.window.localStorage.getItem(CART), null);
    assert.equal(page.window.localStorage.getItem(TOKEN), token);
    assert.doesNotMatch(page.root.textContent, /Payment confirmed/);
    assert.match(page.root.querySelector('[data-mm-checkout-step="4"] button.mm-checkout-next').textContent, /Check payment status/);
  } finally { page.close(); }
});

test("server-confirmed payment clears the matching cart, not a different cart", async () => {
  for (const changedCart of [false, true]) {
    const page = await checkout("paid", { processing: true, changedCart });
    try {
      assert.match(page.root.textContent, /Payment confirmed/);
      assert.equal(page.window.localStorage.getItem(CART) === null, !changedCart);
      assert.equal(page.root.querySelector('[data-mm-checkout-step="4"] button.mm-checkout-next').disabled, true);
    } finally { page.close(); }
  }
});

test("another tab's checkout token protects even an identical cart from a late payment response", async () => {
  const page = await checkout("paid", { processing: true, changedToken: true });
  try {
    assert.notEqual(page.window.localStorage.getItem(CART), null);
    assert.equal(page.window.localStorage.getItem(TOKEN), "3f1ad40c-9fe5-44f4-aaba-98f567b32b70");
    assert.doesNotMatch(page.root.textContent, /Payment confirmed/);
  } finally { page.close(); }
});

test("an unverified return blocks editing and a second payment until status is checked", async () => {
  const page = await checkout("pending", { fail: true });
  try {
    const step = page.root.querySelector('[data-mm-checkout-step="4"]');
    assert.equal(step.querySelector("button.mm-checkout-back").disabled, true);
    assert.equal(step.querySelector("button.mm-checkout-next").disabled, false);
    assert.match(step.querySelector("button.mm-checkout-next").textContent, /Check payment status/);
    step.querySelector("button.mm-checkout-back").click();
    assert.equal(page.root.dataset.mmActiveStep, "4");
  } finally { page.close(); }
});

test("Mailchimp stays pending until its actual callback and rejects provider/network errors", async () => {
  for (const result of ["success", "error", "network"]) {
    const dom = new JSDOM("", { url: "https://holistic-brand-492217.framer.app/", runScripts: "outside-only" });
    try {
      const { submitMailchimpSignup } = load(dom, "MailchimpSignup.tsx", "submitMailchimpSignup");
      const data = new dom.window.FormData(); data.set("EMAIL", "test@example.com"); data.set("FNAME", "Test");
      let settled = false;
      const promise = submitMailchimpSignup(data, new AbortController().signal).then(() => { settled = true; });
      await Promise.resolve(); assert.equal(settled, false);
      const script = dom.window.document.querySelector("script")!;
      const callback = new URL(script.src).searchParams.get("c")!;
      if (result === "network") script.dispatchEvent(new dom.window.Event("error"));
      else (dom.window as any)[callback]({ result, msg: "<b>Invalid email</b>" });
      if (result === "success") await promise;
      else await assert.rejects(promise, /signup|Signup/);
      assert.equal(dom.window.document.querySelector("script"), null);
      assert.equal((dom.window as any)[callback], undefined);
    } finally { dom.window.close(); }
  }
});
