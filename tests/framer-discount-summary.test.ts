/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Framer React harness; requests are intercepted, not sent. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const cartKey = "moving-modesty-cart-v1", discountKey = "moving-modesty-discount-code-v1", methodKey = "moving-modesty-fulfilment-v2";
const cart = [{ id: "test", name: "Amina Tie-Back", colour: "Lavender", size: "One size fits all", price: 420, quantity: 1, image: "" }];
test("Framer summary applies server-validated discounts, rechecks fulfilment, restores frozen amounts and never nests a form", async () => {
  const dom = new JSDOM("<form id='checkout'><div id='root'></div></form>", { url: "https://store.test.invalid/checkout" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], configurable: true, writable: true });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
  dom.window.localStorage.setItem(cartKey, JSON.stringify(cart)); dom.window.localStorage.setItem(methodKey, "delivery");
  let fail = false; const requests: any[] = [];
  const exports: any = {};
  const compiled = ts.transpileModule(readFileSync(new URL("../framer/CheckoutOrderSummary.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(compiled, { exports, window: dom.window, CustomEvent: dom.window.CustomEvent, AbortController, AbortSignal, URLSearchParams,
    require: (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name),
    fetch: async (_url: string, options: any) => {
      const payload = JSON.parse(options.body); requests.push(payload);
      assert.deepEqual(Object.keys(payload).sort(), ["code", "fulfilmentMethod", "items"]);
      if (fail) return Response.json({ error: "Code unavailable" }, { status: 400 });
      const fee = payload.fulfilmentMethod === "delivery" ? 99 : 0;
      return Response.json({ quote: { subtotal: 420, deliveryFee: fee, discountAmount: 42, discountSnapshot: { code: "SALE" }, total: 378 + fee } });
    },
  });
  const root = require("react-dom/client").createRoot(dom.window.document.getElementById("root"));
  const doc = dom.window.document;
  const button = (text: string) => { const element = [...doc.querySelectorAll("button")].find(button => button.textContent === text); assert.ok(element); element.click(); };
  try {
    await act(async () => root.render(React.createElement(exports.default, { discountsEnabled: true, apiBaseUrl: "https://test.invalid" })));
    assert.equal(doc.querySelectorAll("form").length, 1, "discount entry must not nest a form inside checkout");
    const input = doc.querySelector(".mm-checkout-discount input") as HTMLInputElement;
    assert.equal(input.value, "");
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "sale"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await act(async () => button("Apply"));
    assert.equal(requests.length, 1); assert.equal(requests[0].items[0].sku, "AMINA-LAV-OS");
    assert.match(doc.querySelector('[role="status"]')?.textContent || "", /SALE applied/);
    assert.match(doc.body.textContent!, /Discount \(SALE\).*R42.00.*TotalR477.00/);
    assert.equal(dom.window.sessionStorage.getItem(discountKey), "SALE");
    await act(async () => { dom.window.localStorage.setItem(methodKey, "collection"); dom.window.dispatchEvent(new dom.window.CustomEvent("moving-modesty-fulfilment-updated", { detail: "collection" })); });
    assert.equal(requests.length, 2); assert.match(doc.body.textContent!, /TotalR378.00/);
    await act(async () => {
      dom.window.sessionStorage.setItem(discountKey, "OLD"); dom.window.dispatchEvent(new dom.window.CustomEvent("moving-modesty-discount-updated"));
      dom.window.dispatchEvent(new dom.window.CustomEvent("moving-modesty-order-updated", { detail: { subtotal: 420, deliveryFee: 0, discountAmount: 63, discountSnapshot: { code: "OLD" }, total: 357, fulfilmentMethod: "collection", items: [{ sku: "AMINA-LAV-OS", quantity: 1 }] } }));
    });
    assert.equal(requests.length, 2, "saved payment snapshot must not be revalidated against today's edited code");
    assert.match(doc.body.textContent!, /Discount \(OLD\).*R63.00.*TotalR357.00/);
    fail = true;
    await act(async () => { dom.window.localStorage.setItem(cartKey, JSON.stringify([{ ...cart[0], quantity: 2 }])); dom.window.dispatchEvent(new dom.window.CustomEvent("moving-modesty-cart-updated")); });
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /Code unavailable/);
    assert.equal(dom.window.sessionStorage.getItem(discountKey), null);
    assert.match(doc.body.textContent!, /TotalR840.00/);
    assert.doesNotMatch(doc.body.textContent!, /Discount \(OLD\)/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
