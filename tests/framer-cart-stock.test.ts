/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Framer DOM harness. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url), React = require("react");
const { createRoot } = require("react-dom/client");
const CART_KEY = "moving-modesty-cart-v1";
const item = (sku: string, quantity = 1) => ({ id: sku, sku, productSlug: "hawa-tri-instant-scarf-grey", name: "Hawa Tri-Instant", colour: "Grey", size: sku.endsWith("-L") ? "Large" : "Small", price: 450, priceLabel: "R 450.00", image: "", quantity });
const variants = () => [ { sku: "HAWA-GRY-S", size: "Small", available: true, stock: 5 }, { sku: "HAWA-GRY-L", size: "Large", available: false, stock: null } ];

async function harness(file: string, cart: any[]) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://store.test.invalid/cart", runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window as any, responses = variants(), requests: string[] = [];
  let fail = false, nextResponse: (() => Promise<any>) | undefined;
  window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
  window.require = (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name);
  window.exports = {}; window.AbortController = AbortController;
  window.fetch = async (url: string) => {
    requests.push(url);
    if (nextResponse) { const response = nextResponse; nextResponse = undefined; return response(); }
    if (fail) throw new Error("Test network error");
    return { ok: true, json: async () => ({ variants: structuredClone(responses) }) };
  };
  const compiled = ts.transpileModule(readFileSync(new URL(`../framer/${file}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  window.eval(compiled);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const root = createRoot(window.document.getElementById("root"));
  const Label = React.forwardRef(function CountLabel(props: any, ref: any) { return React.createElement("p", { ref, style: props.style, "aria-label": props["aria-label"] }, props.text); });
  const Component = file === "CartCount" ? window.exports.withCartCount(Label) : window.exports.default;
  await React.act(async () => root.render(React.createElement(Component, { style: { color: "rgb(51, 43, 37)" } })));
  return {
    window, responses, requests,
    button: () => window.document.querySelector(".mm-cart-button"),
    status: () => window.document.getElementById("mm-cart-stock-status")?.textContent,
    click: async (selector: string) => React.act(async () => window.document.querySelector(selector).click()),
    setFailure: (value: boolean) => { fail = value; },
    deferNext: (callback: () => Promise<any>) => { nextResponse = callback; },
    event: async (name: string) => React.act(async () => window.dispatchEvent(new window.Event(name))),
    changeCart: async (next: any[], event = "moving-modesty-cart-updated") => React.act(async () => {
      window.localStorage.setItem(CART_KEY, JSON.stringify(next));
      window.dispatchEvent(event === "storage" ? new window.StorageEvent("storage", { key: CART_KEY }) : new window.Event(event));
    }),
    async close() {
      await React.act(async () => root.unmount());
      for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      dom.window.close();
    },
  };
}

test("existing cart label totals quantities, updates events/navigation and hides at zero", async () => {
  const page = await harness("CartCount", [item("HAWA-GRY-S", 2), item("HAWA-GRY-L", 1)]);
  try {
    const label = () => page.window.document.querySelector("p");
    assert.equal(label().textContent, "3"); assert.equal(label().style.color, "rgb(51, 43, 37)");
    await page.changeCart([item("HAWA-GRY-S", 4)]); assert.equal(label().textContent, "4");
    await page.changeCart([item("HAWA-GRY-S", 1)], "storage"); assert.equal(label().textContent, "1");
    page.window.localStorage.setItem(CART_KEY, JSON.stringify([item("HAWA-GRY-S", 7)]));
    await page.event("pageshow"); assert.equal(label().textContent, "7");
    await page.changeCart([]); assert.equal(label().style.display, "none");
    await page.changeCart([item("HAWA-GRY-S", 2)]); assert.equal(label().style.display, "");
    page.window.localStorage.setItem(CART_KEY, "corrupt"); await page.event("focus"); assert.equal(label().textContent, "0");
  } finally { await page.close(); }
});

test("stale sold-out cart lines block checkout until removed", async () => {
  const page = await harness("CartContents", [item("HAWA-GRY-S"), item("HAWA-GRY-L")]);
  try {
    assert.equal(page.button().disabled, true);
    assert.match(page.window.document.body.textContent, /SOLD OUT — remove this item/);
    assert.equal(page.requests.length, 1, "Variants of one colour share a stock request");
    await page.click(".mm-cart-row:last-child .mm-remove");
    assert.equal(page.button().disabled, false);
    assert.equal(JSON.parse(page.window.localStorage.getItem(CART_KEY)).length, 1);
    page.responses[0].available = false;
    await page.event("focus"); assert.equal(page.button().disabled, true);
    assert.match(page.window.document.body.textContent, /SOLD OUT/);
  } finally { await page.close(); }
});

test("older saved carts retain checkout compatibility without rewriting their contents", async () => {
  const legacy = { ...item("HAWA-GRY-S", 2), id: "old-hawa-grey-small", sku: undefined, productSlug: undefined };
  const page = await harness("CartContents", [legacy]);
  try {
    assert.match(page.requests[0], /base=HAWA-GRY$/);
    assert.equal(page.button().disabled, false);
    assert.equal(JSON.parse(page.window.localStorage.getItem(CART_KEY))[0].sku, undefined);
    await page.changeCart([{ ...legacy, size: "Large" }]);
    assert.equal(page.button().disabled, true); assert.match(page.window.document.body.textContent, /SOLD OUT/);
  } finally { await page.close(); }
});

test("checkout click revalidates stock and blocks a newly unavailable variant", async () => {
  const page = await harness("CartContents", [item("HAWA-GRY-S")]);
  try {
    assert.equal(page.button().disabled, false);
    page.responses[0].available = false;
    await page.click(".mm-cart-button");
    assert.equal(page.requests.length, 2);
    assert.equal(page.button().disabled, true);
    assert.match(page.window.document.body.textContent, /SOLD OUT/);
    assert.equal(page.window.location.pathname, "/cart");
  } finally { await page.close(); }
});

test("stock limits, unknown items and network failures fail closed with recovery", async () => {
  const page = await harness("CartContents", [item("HAWA-GRY-S", 6)]);
  try {
    assert.equal(page.button().disabled, true); assert.match(page.window.document.body.textContent, /Only 5 available/);
    await page.click('[aria-label="Decrease quantity"]'); assert.equal(page.button().disabled, false);
    assert.equal(page.window.document.querySelector('[aria-label="Increase quantity"]').disabled, true);
    page.setFailure(true); await page.event("focus");
    assert.equal(page.button().disabled, true); assert.match(page.status(), /could not be checked/);
    page.setFailure(false); await page.click("#mm-cart-stock-status button"); assert.equal(page.button().disabled, false);
    await page.changeCart([item("FORGED-SKU")]); assert.equal(page.button().disabled, true);
  } finally { await page.close(); }
});

test("an older stock response cannot re-enable checkout after the cart changes", async () => {
  const page = await harness("CartContents", [item("HAWA-GRY-S")]);
  let complete!: (response: any) => void;
  try {
    page.deferNext(() => new Promise(resolve => { complete = resolve; }));
    await page.event("focus");
    await page.changeCart([item("HAWA-GRY-L")]);
    assert.equal(page.button().disabled, true);
    await React.act(async () => complete({ ok: true, json: async () => ({ variants: variants() }) }));
    assert.equal(page.button().disabled, true); assert.match(page.window.document.body.textContent, /SOLD OUT/);
  } finally { await page.close(); }
});
