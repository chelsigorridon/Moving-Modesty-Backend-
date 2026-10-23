/* eslint-disable @typescript-eslint/no-explicit-any -- Offline browser fixture, no live API or credentials. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const fixture = { id: "MM-REFRESH-TEST", customer: "Sample Customer", email: "sample@example.invalid", phone: "0000000000", placedAt: "23 Oct, 01:15 SAST", total: 519,
  paymentStatus: "Paid", status: "Ready", deliveryMethod: "Courier", address: "Sample address", items: [{ name: "Scarf", variant: "Sample", quantity: 1, price: 420 }],
  workflow: { nextStatus: null, canCancel: false, guidance: "Sample order" },
  shipping: { provider: "Bob Go", environment: "production", status: "Booked", courierStatus: "pending-collection", trackingNumber: "TEST-ONLY", senderLocationName: "Sample sender", bookingEnabled: true, blockers: [], weightGrams: 267, lengthCm: 25, widthCm: 20, heightCm: 3 } };

async function harness(check: (context: any) => Promise<void>, parcel = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://store.example.invalid/admin/orders?order=MM-REFRESH-TEST", runScripts: "outside-only" });
  const win = dom.window as any, originals = new Map<string, PropertyDescriptor | undefined>();
  win.Headers = Headers; win.AbortSignal = AbortSignal; win.AbortController = AbortController;
  for (const [name, value] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  let clock = Date.parse("2026-10-22T23:15:00Z"), hidden = false;
  win.Date.now = () => clock;
  Object.defineProperty(win.document, "visibilityState", { get: () => hidden ? "hidden" : "visible", configurable: true });
  const timers = new Map<number, () => void>(); let timerId = 0;
  win.setInterval = (callback: () => void, ms: number) => { assert.equal(ms, 60_000); timers.set(++timerId, callback); return timerId; };
  win.clearInterval = (id: number) => timers.delete(id);
  win.require = (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name);
  win.exports = {};
  let order: any = structuredClone(fixture), fail = false, defer = false;
  if (parcel) order.shipping = { ...order.shipping, status: "Not ready", weightGrams: 278 };
  const requests: string[] = [], held: Array<() => void> = [];
  win.fetch = async (url: string, init: any = {}) => {
    assert.equal(new URL(url).pathname, "/api/admin/data", "Background refresh must not call provider, diagnostics or mutation endpoints");
    assert.equal(init.method || "GET", "GET"); requests.push(url);
    const full = Boolean(new URL(url).searchParams.get("order")), saved = structuredClone(order), failed = fail;
    const respond = () => {
      if (failed) throw new TypeError("TEST offline");
      return Response.json({ orders: full ? [saved] : [{ ...saved, detailsLoaded: false, items: [] }], bobGoConnection: { enabled: true, configured: true, environment: "production" } });
    };
    if (defer) return new Promise((resolve, reject) => held.push(() => { try { resolve(respond()); } catch (error) { reject(error); } }));
    return respond();
  };
  win.sessionStorage.setItem("moving_modesty_admin_token", "LOCAL-TEST-ONLY");
  win.eval(compiled);
  const doc = win.document, root = require("react-dom/client").createRoot(doc.getElementById("root"));
  const advance = async (event = "timer") => {
    clock += 60_000;
    await act(async () => {
      if (event === "timer") for (const callback of [...timers.values()]) callback();
      else if (event === "focus") win.dispatchEvent(new win.Event("focus"));
      else doc.dispatchEvent(new win.Event("visibilitychange"));
    });
  };
  const click = async (label: string) => {
    const button = [...doc.querySelectorAll("button")].find((node: any) => node.textContent === label) as HTMLButtonElement;
    assert.ok(button, label); await act(async () => button.click());
  };
  try {
    await act(async () => root.render(React.createElement(win.exports.default, { view: "orders", apiBaseUrl: "https://api.example.invalid" })));
    await check({ win, doc, requests, timers, advance, click, setFailure: (value: boolean) => { fail = value; }, setHidden: (value: boolean) => { hidden = value; },
      setStatus: (status: string, courierStatus = "cancelled") => { order = { ...order, shipping: { ...order.shipping, status, courierStatus } }; },
      defer: () => { defer = true; }, release: async () => { defer = false; await act(async () => { for (const run of held.splice(0)) run(); }); },
    });
  } finally {
    await act(async () => root.unmount()); assert.equal(timers.size, 0, "Unmount cleans polling timers"); dom.window.close();
    for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
}

test("visible polling refreshes the opened order to cancelled using GET only, without remounting the card", async () => {
  await harness(async ({ doc, requests, setStatus, advance }) => {
    const card = doc.querySelector(".mm-admin__order-card"), detail = doc.querySelector(".mm-admin__detail");
    assert.match(detail.textContent, /Status: Booked/); const before = requests.length;
    setStatus("Cancelled"); await advance();
    assert.equal(requests.length, before + 2); assert.equal(doc.querySelector(".mm-admin__order-card"), card);
    assert.equal(doc.querySelector(".mm-admin__detail"), detail); assert.equal(card.getAttribute("aria-expanded"), "true");
    assert.match(detail.textContent, /Status: Cancelled/); assert.match(doc.body.textContent, /Status checked:.*SAST/);
  });
});

test("hidden tabs do not poll; visibility and focus re-read with duplicate and in-flight suppression", async () => {
  await harness(async ({ win, requests, advance, setHidden, defer, release }) => {
    const before = requests.length;
    setHidden(true); await advance(); assert.equal(requests.length, before);
    setHidden(false); await advance("visibility"); assert.equal(requests.length, before + 2);
    await act(async () => win.dispatchEvent(new win.Event("focus"))); assert.equal(requests.length, before + 2, "Focus/visibility burst is throttled");
    defer(); await advance("focus"); const pending = requests.length;
    await advance(); assert.equal(requests.length, pending, "No overlapping polls"); await release();
  });
});

test("failed background reads keep the current order visible and retry without telemetry writes", async () => {
  await harness(async ({ doc, setFailure, setStatus, advance }) => {
    setFailure(true); await advance();
    assert.match(doc.querySelector(".mm-admin__detail").textContent, /Status: Booked/);
    assert.match(doc.body.textContent, /Automatic status check unavailable/);
    setFailure(false); setStatus("Cancelled"); await advance();
    assert.doesNotMatch(doc.body.textContent, /Automatic status check unavailable/);
    assert.match(doc.querySelector(".mm-admin__detail").textContent, /Status: Cancelled/);
  });
});

test("focused and unsaved parcel inputs pause background refresh without losing their value", async () => {
  await harness(async ({ doc, win, requests, advance }) => {
    const input = doc.querySelector('.mm-parcel input, .mm-admin__parcel-grid input, input[inputmode="numeric"]') as HTMLInputElement;
    assert.ok(input); input.focus(); const before = requests.length;
    await advance(); assert.equal(requests.length, before);
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "777");
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    input.blur(); await advance(); assert.equal(requests.length, before);
    assert.equal(input.value, "777"); assert.ok(doc.contains(input));
  }, true);
});

test("a delayed read cannot reopen a closed order or overwrite a newer manual refresh", async () => {
  await harness(async ({ doc, requests, setStatus, defer, advance, click, release }) => {
    defer(); setStatus("Cancelled"); await advance(); const pending = requests.length;
    await click("Close details"); await release();
    assert.equal(doc.querySelector(".mm-admin__detail"), null);
    assert.equal(doc.querySelector(".mm-admin__order-card").getAttribute("aria-expanded"), "false");
    assert.equal(requests.length, pending);
    await click("Refresh orders");
    assert.equal(doc.querySelector(".mm-admin__detail"), null);
  });
});

test("South African client timestamps ignore browser timezone and use an explicit label", () => {
  const fn = source.match(/function southAfricanTime\([\s\S]*?\r?\n}\r?\n/)![0];
  const js = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const format = new Function(js + ";return southAfricanTime;")();
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    const old = process.env.TZ;
    try { process.env.TZ = zone; assert.match(format("2026-10-22T23:15:00Z"), /23 Oct 2026.*01:15 SAST$/); }
    finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
  }
  assert.equal(format("bad date"), "Not recorded");
});
