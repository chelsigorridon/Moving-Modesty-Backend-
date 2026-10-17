/* eslint-disable @typescript-eslint/no-explicit-any -- Browser/API fixtures only; never signs into a real account. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { JSDOM } from "jsdom";

test("the private test never presets a drop-off point or measurements and cannot book on mount or refresh", async () => {
  const require = createRequire(import.meta.url), dom = new JSDOM('<div id="root"></div>', { url: "https://offline.test.invalid/courier-test", runScripts: "outside-only" });
  const window = dom.window as any, cache = new Map<string, any>(), calls: string[] = [];
  window.structuredClone = structuredClone;
  function load(name: string): any {
    if (!name.startsWith("./")) return require(name);
    if (cache.has(name)) return cache.get(name);
    const exports = {}; cache.set(name, exports);
    const compiled = ts.transpileModule(readFileSync(new URL(`../components/${name.slice(2)}.tsx`, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    window.eval(`(function(require,exports){${compiled}\n})`)(load, exports);
    return exports;
  }
  const contact = { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" };
  const delivery = { kind: "door", contact: { ...contact, name: "Test Test" }, address: { company: "", line1: "87 Offline Test Road", line2: "", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "7764" } };
  const order: any = { id: "MM-COURIER-TEST-OFFLINE", customer: "Test Test", paymentStatus: "Paid", status: "Ready", address: "OFFLINE address",
    workflow: { nextStatus: null }, shipping: { status: "Not ready" },
    deliveryDetails: { revision: 1, plan: null, canEdit: true, privateNote: "", draftPlan: { version: 1,
      collection: { kind: "pickup_point", contact, point: { id: "999", name: "Existing default point must not be selected", providerSlug: "fixture" } },
      delivery, collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false } } };
  window.fetch = async (path: string, options: any) => {
    calls.push(path);
    if (path === "/api/admin/login") { assert.equal(JSON.parse(options.body).password, "OFFLINE-not-a-real-password"); return { ok: true, json: async () => ({ token: "OFFLINE-session-only" }) }; }
    assert.equal(path, "/api/admin/courier-test"); assert.equal(options.method, "GET");
    return { ok: true, json: async () => ({ order: structuredClone(order), enabled: true, archived: false }) };
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const root = require("react-dom/client").createRoot(window.document.getElementById("root"));
  try {
    await React.act(async () => root.render(React.createElement(load("./courier-test").default)));
    assert.equal(calls.length, 0, "Opening the test page creates nothing");
    const doc = window.document;
    doc.querySelector('[name="email"]').value = "owner@example.invalid";
    doc.querySelector('[name="password"]').value = "OFFLINE-not-a-real-password";
    await React.act(async () => doc.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    assert.deepEqual(calls, ["/api/admin/login", "/api/admin/courier-test"]);
    assert.match(doc.body.textContent, /Choose your drop-off point/);
    assert.doesNotMatch(doc.body.textContent, /Existing default point must not be selected/);
    assert.equal(doc.querySelector('.mm-admin__parcel-editor'), null, "Choose and save collection before quoting");
    order.deliveryDetails.plan = { ...order.deliveryDetails.draftPlan, collection: { kind: "pickup_point", contact, point: { id: "42", name: "Manually selected point", providerSlug: "fixture" } } };
    order.deliveryDetails.draftPlan = order.deliveryDetails.plan; order.deliveryDetails.revision++;
    const button = [...doc.querySelectorAll("button")].find((item: any) => item.textContent === "Refresh TEST order");
    await React.act(async () => button.click());
    const numbers = [...doc.querySelectorAll('.mm-admin__parcel-editor input[type="number"]')];
    assert.equal(numbers.length, 4); assert.ok(numbers.every((input: any) => input.value === ""));
    const quote = [...doc.querySelectorAll("button")].find((item: any) => /Get live courier quotes/.test(item.textContent));
    assert.equal(quote.disabled, true);
    assert.ok(![...doc.querySelectorAll("button")].some((item: any) => /Book real TEST waybill/.test(item.textContent)));
    assert.equal(calls.length, 3, "Mount, sign-in and refresh cannot request rates, payment, booking or cancellation");
  } finally {
    await React.act(async () => root.unmount());
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    dom.window.close();
  }
});
