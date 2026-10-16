/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Framer DOM harness. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url), React = require("react");
const { createRoot } = require("react-dom/client");
const compiled = ts.transpileModule(readFileSync(new URL("../framer/ProductPurchase.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

async function harness(props: any, suppliedVariants?: any[], failures = { remaining: 0 }) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://holistic-brand-492217.framer.app/amina", runScripts: "outside-only" });
  const window = dom.window as any, requests: string[] = [];
  window.require = (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name);
  window.exports = {};
  window.AbortController = AbortController; window.AbortSignal = AbortSignal;
  window.fetch = async (url: string) => {
    requests.push(url);
    if (failures.remaining > 0) { failures.remaining--; throw new TypeError("Failed to fetch"); }
    return { ok: true, json: async () => ({ variants: suppliedVariants ?? [{ sku: "AMINA-LAV-OS", slug: "amina-tie-back-lavender", name: "Amina Tie-Back", colour: "Lavender", size: "One size fits all", price: 420, image: "", available: true, stock: 2 }] }) };
  };
  window.eval(compiled);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const root = createRoot(window.document.getElementById("root"));
  const render = async (next: any) => React.act(async () => root.render(React.createElement(window.exports.default, { sizeMode: "oneSize", ...next })));
  await render(props);
  return {
    window, requests, render,
    button: () => window.document.querySelector(".mm-product-button"),
    async add() { await React.act(async () => window.document.querySelector(".mm-product-button").click()); },
    async close() {
      await React.act(async () => root.unmount());
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    },
  };
}

test("a CMS slug keeps purchase working when the hydrated SKU binding is empty", async () => {
  const page = await harness({ sku: "AMINA-LAV", productSlug: "amina-tie-back-lavender" });
  try {
    await page.render({ sku: "", productSlug: "amina-tie-back-lavender" });
    assert.match(page.requests.at(-1)!, /base=amina-tie-back-lavender$/);
    assert.equal(page.button().disabled, false);
    await page.add();
    const cart = JSON.parse(page.window.localStorage.getItem("moving-modesty-cart-v1"));
    assert.equal(cart[0].sku, "AMINA-LAV-OS", "The server, not a guessed name, supplies checkout SKU");
    assert.equal(cart[0].price, 420);
    assert.equal(cart[0].quantity, 1);
  } finally { await page.close(); }
});

test("adding to an old cart merges every matching legacy line and respects the aggregate stock limit", async () => {
  const variants = [{ sku: "AMINA-LAV-OS", size: "One size fits all", name: "Amina Tie-Back", colour: "Lavender", price: 420, image: "", available: true, stock: 6 }];
  const page = await harness({ sku: "AMINA-LAV", productSlug: "amina-tie-back-lavender" }, variants);
  try {
    const old = { id: "old-lavender::one-size", name: "Amina Tie-Back - Lavender", colour: "Lavender", size: "One size fits all", price: 420, quantity: 4 };
    page.window.localStorage.setItem("moving-modesty-cart-v1", JSON.stringify([old, { ...old, id: "AMINA-LAV-OS", sku: "AMINA-LAV-OS", quantity: 1 }]));
    await page.add();
    const cart = JSON.parse(page.window.localStorage.getItem("moving-modesty-cart-v1"));
    assert.equal(cart.length, 1); assert.equal(cart[0].id, "AMINA-LAV-OS"); assert.equal(cart[0].quantity, 6);
    await page.add();
    assert.equal(JSON.parse(page.window.localStorage.getItem("moving-modesty-cart-v1"))[0].quantity, 6);
    assert.match(page.window.document.body.textContent, /already added the available quantity/);
  } finally { await page.close(); }
});

test("Hawa keeps sold-out Large selectable, disables purchasing, then restores Small", async () => {
  const variants = [
    { sku: "HAWA-GRY-S", size: "Small", available: true, stock: null, name: "Hawa Tri-Instant", colour: "Grey", price: 450, image: "" },
    { sku: "HAWA-GRY-L", size: "Large", available: false, stock: null, name: "Hawa Tri-Instant", colour: "Grey", price: 450, image: "" },
  ];
  const page = await harness({ sku: "HAWA-GRY", productSlug: "hawa-tri-instant-scarf-grey", sizeMode: "hawa" }, variants);
  const select = async (value: string) => React.act(async () => {
    const input = page.window.document.querySelector("select"); input.value = value;
    input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  });
  try {
    const large = page.window.document.querySelector('option[value="Large"]');
    assert.equal(large.disabled, false);
    assert.match(large.textContent, /Out of stock/);
    await select("Large");
    assert.equal(page.button().textContent, "Out of stock");
    assert.equal(page.button().disabled, true);
    await page.add();
    assert.equal(page.window.localStorage.getItem("moving-modesty-cart-v1"), null);
    await select("Small");
    assert.equal(page.button().disabled, false);
    await page.add();
    const item = JSON.parse(page.window.localStorage.getItem("moving-modesty-cart-v1"))[0];
    assert.equal(item.sku, "HAWA-GRY-S"); assert.equal(item.size, "Small"); assert.equal(item.colour, "Grey");
    variants[0].available = false;
    await React.act(async () => page.window.dispatchEvent(new page.window.Event("focus")));
    assert.equal(page.button().textContent, "Out of stock"); assert.equal(page.button().disabled, true);
  } finally { await page.close(); }
});

test("stock changes immediately before add are rechecked and never saved to cart", async () => {
  const variants = [{ sku: "HAWA-GRY-S", size: "Small", available: true, stock: null, name: "Hawa", colour: "Grey", price: 450 }];
  const page = await harness({ sku: "HAWA-GRY", sizeMode: "hawa" }, variants);
  try {
    variants[0].available = false;
    await page.add();
    assert.equal(page.window.localStorage.getItem("moving-modesty-cart-v1"), null);
    assert.equal(page.button().textContent, "Out of stock");
  } finally { await page.close(); }
});

test("missing product identity fails closed instead of checking availability forever", async () => {
  const page = await harness({ sku: "", productSlug: "" });
  try {
    assert.equal(page.requests.length, 0);
    assert.equal(page.button().disabled, true);
    assert.equal(page.button().textContent, "Stock check unavailable");
  } finally { await page.close(); }
});

test("a failed availability check is not an out-of-stock claim and its single retry action never adds to cart", async () => {
  const page = await harness({ sku: "AMINA-LAV", productSlug: "amina-tie-back-lavender" }, undefined, { remaining: 1 });
  try {
    assert.equal(page.button().textContent, "Retry stock check");
    assert.equal(page.button().disabled, false);
    assert.match(page.window.document.body.textContent, /Stock couldn’t be checked/);
    assert.doesNotMatch(page.window.document.body.textContent, /Out of stock|Temporarily unavailable/);
    assert.equal(page.window.document.querySelectorAll("button").length, 1);
    await page.add();
    assert.equal(page.window.localStorage.getItem("moving-modesty-cart-v1"), null, "retry checks stock only");
    assert.equal(page.button().textContent, "Add to cart");
    assert.equal(page.button().disabled, false);
    await page.add();
    assert.equal(JSON.parse(page.window.localStorage.getItem("moving-modesty-cart-v1"))[0].sku, "AMINA-LAV-OS");
  } finally { await page.close(); }
});
