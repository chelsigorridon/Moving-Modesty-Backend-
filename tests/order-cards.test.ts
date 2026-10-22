/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic browser fixtures; no real sessions, orders or providers. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const portal = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
const shared = readFileSync(new URL("../components/order-cards.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(portal, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const fixtures = ["One", "Two", "Three"].map((name, i) => ({
  id: `DEMO-${i + 1}`, customer: `Sample ${name}`, email: "customer@example.invalid", phone: "0000000000",
  placedAt: "22 Oct, 10:15", total: 420, deliveryFee: 0, paymentStatus: "Paid", status: "New",
  deliveryMethod: i === 2 ? "Courier" : "Collection", items: [{ quantity: 1, name: "Sample scarf", variant: "Example", price: 420 }],
  workflow: { guidance: "Review this sample order.", canCancel: false },
}));

async function harness(check: (context: any) => Promise<void>, query = "", initial = fixtures) {
  const dom = new JSDOM('<div id="root"></div>', { url: `https://store.test.invalid/admin/orders${query}`, runScripts: "outside-only" });
  const win = dom.window as any, originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.require = (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name);
  win.exports = {};
  const requests: string[] = [];
  let currentOrders = initial;
  win.fetch = async (url: string, init: any = {}) => {
    assert.equal(new URL(url).pathname, "/api/admin/data", "Only fake admin reads are allowed");
    assert.equal(init.method || "GET", "GET", "Opening cards must not mutate anything");
    requests.push(url);
    return Response.json({ orders: currentOrders });
  };
  win.sessionStorage.setItem("moving_modesty_admin_token", "TEST-only-no-real-session");
  win.eval(compiled);
  const doc = win.document, root = require("react-dom/client").createRoot(doc.getElementById("root"));
  const cards = () => [...doc.querySelectorAll('.mm-admin__order-card')] as HTMLButtonElement[];
  const opened = () => cards().filter(node => node.getAttribute("aria-expanded") === "true");
  const details = () => [...doc.querySelectorAll('.mm-admin__detail')];
  const click = async (text: string) => {
    const button = [...doc.querySelectorAll('button')].find((node: any) => node.textContent === text) as HTMLButtonElement;
    assert.ok(button, `Missing button: ${text}`); await act(async () => button.click());
  };
  const toggle = async (index: number) => { await act(async () => cards()[index].click()); };
  const input = async (value: string) => {
    const field = doc.querySelector('input[type="search"]') as HTMLInputElement;
    field.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    return field;
  };
  try {
    await act(async () => root.render(React.createElement(win.exports.default, { view: "orders", apiBaseUrl: "https://api.test.invalid" })));
    await check({ doc, win, cards, opened, details, requests, click, toggle, input, setOrders: (orders: typeof fixtures) => { currentOrders = orders; } });
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
}

test("orders start closed; each real button controls its own hidden detail panel", async () => {
  await harness(async ({ doc, cards, opened, details, requests }) => {
    assert.equal(cards().length, 3); assert.equal(opened().length, 0); assert.equal(details().length, 0);
    for (const card of cards()) {
      assert.equal(card.type, "button"); assert.equal(card.getAttribute("aria-expanded"), "false");
      const panel = doc.getElementById(card.getAttribute("aria-controls"));
      assert.ok(panel.hidden); assert.equal(panel.getAttribute("aria-labelledby"), card.id);
      assert.equal(panel.children.length, 0);
    }
    assert.equal(requests.length, 1);
  });
});
test("only one order opens at a time, directly beneath its card; same card toggles closed", async () => {
  await harness(async ({ cards, opened, details, requests, toggle }) => {
    await toggle(0); assert.equal(opened().length, 1); assert.equal(details().length, 1);
    assert.equal(details()[0].parentElement.previousElementSibling, cards()[0]);
    assert.equal(details()[0].getAttribute("aria-label"), "Details for DEMO-1");
    await toggle(1); assert.equal(opened().length, 1); assert.equal(details().length, 1);
    assert.equal(opened()[0], cards()[1]); assert.equal(details()[0].getAttribute("aria-label"), "Details for DEMO-2");
    await toggle(1); assert.equal(opened().length, 0); assert.equal(details().length, 0);
    assert.equal(requests.length, 1);
  });
});
test("both Close details controls collapse the card and restore focus without any request", async () => {
  await harness(async ({ doc, cards, opened, requests, toggle }) => {
    for (const index of [0, 1]) {
      await toggle(1);
      const buttons = [...doc.querySelectorAll('button.mm-admin__close-details')] as HTMLButtonElement[];
      assert.equal(buttons.length, 2);
      await act(async () => buttons[index].click());
      assert.equal(opened().length, 0); assert.equal(doc.activeElement, cards()[1]);
    }
    assert.equal(requests.length, 1);
  });
});
test("refresh preserves an explicit selection or closed state; removed orders never fall back to another", async () => {
  await harness(async ({ opened, toggle, click, setOrders }) => {
    await click("Refresh orders"); assert.equal(opened().length, 0);
    await toggle(1); await click("Refresh orders"); assert.match(opened()[0].textContent, /Sample Two/);
    await click("Close details"); await click("Refresh orders"); assert.equal(opened().length, 0);
    await toggle(1); setOrders([fixtures[0], fixtures[2]]); await click("Refresh orders"); assert.equal(opened().length, 0);
  });
});
test("search and filters close details without auto-opening or stealing the search focus", async () => {
  await harness(async ({ doc, cards, opened, toggle, click, input, win }) => {
    await toggle(0);
    const search = await input("Sample Two");
    assert.equal(cards().length, 1); assert.equal(opened().length, 0); assert.equal(doc.activeElement, search);
    await input(""); assert.equal(cards().length, 3); assert.equal(opened().length, 0);
    await toggle(0); await click("All orders"); assert.equal(opened().length, 0);
    await toggle(0);
    const select = doc.querySelector('select');
    await act(async () => { select.value = "Courier"; select.dispatchEvent(new win.Event("change", { bubbles: true })); });
    assert.equal(cards().length, 1); assert.equal(opened().length, 0);
    await input("no-such-order"); assert.equal(cards().length, 0); assert.match(doc.body.textContent, /No matching orders/);
  });
});
test("specific-order links open only that order once; closing then refreshing stays closed", async () => {
  await harness(async ({ opened, click }) => {
    assert.equal(opened().length, 1); assert.match(opened()[0].textContent, /Sample Two/);
    await click("Close details"); await click("Refresh orders"); assert.equal(opened().length, 0);
  }, "?order=DEMO-2");
  await harness(async ({ opened }) => { assert.equal(opened().length, 0); }, "?order=does-not-exist");
});
test("empty orders do not invent a selected order", async () => {
  await harness(async ({ doc, opened, cards }) => {
    assert.equal(cards().length, 0); assert.equal(opened().length, 0); assert.match(doc.body.textContent, /No matching orders/);
  }, "", []);
});
test("preview uses the exact bundled disclosure and stays development-only with no provider actions", () => {
  const embedded = portal.split("// BEGIN_MM_ORDER_CARDS\n")[1]?.split("// END_MM_ORDER_CARDS")[0]?.trim();
  const expected = shared.replace(/^"use client";\s*/m, "").replace(/^import[^\n]+from "react";\s*/m, "")
    .replace("export default function OrderCards", "function EmbeddedOrderCards").trim();
  assert.equal(embedded, expected); assert.equal(portal.split("// BEGIN_MM_ORDER_CARDS").length, 2);
  assert.match(shared, /min-height:44px/); assert.match(shared, /focus-visible/); assert.match(shared, /overflow-wrap:anywhere/);
  assert.doesNotMatch(shared, /fetch\(|requestShipping|updateOrderStatus|localStorage|sessionStorage/);
  const review = readFileSync(new URL("../app/order-cards-review/page.tsx", import.meta.url), "utf8");
  assert.match(review, /NODE_ENV !== "development" \|\| process.env.VERCEL_ENV/);
  assert.ok(review.indexOf("notFound();") < review.indexOf("await readFile"));
});
