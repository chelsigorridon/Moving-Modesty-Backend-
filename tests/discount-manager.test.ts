/* eslint-disable @typescript-eslint/no-explicit-any -- React/jsdom harness, with isolated API doubles and no network. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
async function mount(options: any, fetcher: any, run: (doc: Document, root: any) => Promise<void>, sessionToken = "") {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/discount-review" });
  if (sessionToken) dom.window.sessionStorage.setItem("moving_modesty_admin_token", sessionToken);
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], configurable: true, writable: true });
  const exports: any = {};
  const compiled = ts.transpileModule(readFileSync(new URL("../components/discount-manager.tsx", import.meta.url), "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(compiled, { exports, require, crypto: globalThis.crypto, window: dom.window, AbortController, AbortSignal, fetch: fetcher });
  const root = require("react-dom/client").createRoot(dom.window.document.getElementById("root"));
  try { await act(async () => root.render(React.createElement(exports.default, options))); await run(dom.window.document, root); }
  finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
function field(doc: Document, label: string) {
  const element = [...doc.querySelectorAll("label")].find(element => element.firstChild?.textContent === label)?.querySelector("input,select") as HTMLInputElement;
  assert.ok(element, `Missing field ${label}`); return element;
}
function fill(doc: Document, label: string, value: string) {
  const element = field(doc, label);
  const proto = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}
function click(doc: Document, text: string) {
  const element = [...doc.querySelectorAll("button")].find(element => element.textContent === text || element.textContent?.trim() === text);
  assert.ok(element, `Missing button ${text}`); element.click();
}
test("review starts empty and OFF, supports editable shared codes and an ON/OFF switch without live writes", async () => {
  let calls = 0;
  await mount({ demo: true, products: [{ id: "amina", name: "Amina" }, { id: "hawa", name: "Hawa" }] }, () => { calls++; throw new Error("No live writes"); }, async doc => {
    assert.match(doc.body.textContent!, /No discounts yet/);
    await act(async () => click(doc, "Create discount"));
    assert.equal(field(doc, "Discount code").value, ""); assert.equal(field(doc, "Percentage off").value, "");
    assert.equal(doc.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
    assert.equal(doc.querySelector("details")?.open, false);
    await act(async () => { fill(doc, "Discount code", "welcome"); fill(doc, "Percentage off", "10"); });
    await act(async () => fill(doc, "Applies to", "selected"));
    await act(async () => click(doc, "Save discount"));
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /Select at least one product/);
    assert.equal(field(doc, "Applies to").value, "selected", "deselecting everything must not silently apply the discount to all products");
    await act(async () => fill(doc, "Applies to", "all"));
    await act(async () => click(doc, "Save discount"));
    assert.match(doc.querySelector("article")?.textContent || "", /WELCOME.*10% off/);
    assert.equal(doc.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
    await act(async () => click(doc, "OFF"));
    assert.equal(doc.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "true");
    await act(async () => (doc.querySelector("article button") as HTMLButtonElement).click());
    await act(async () => { fill(doc, "Discount code", "special"); fill(doc, "Percentage off", "15"); });
    await act(async () => click(doc, "Save discount"));
    assert.match(doc.querySelector("article")?.textContent || "", /SPECIAL.*15% off/);
    assert.doesNotMatch(doc.querySelector("article")?.textContent || "", /WELCOME/);
    await act(async () => click(doc, "ON"));
    assert.equal(doc.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
    assert.equal(calls, 0);
  });
});
test("connected manager retains failed edits and only changes a switch after a confirmed backend save", async () => {
  const record = { id: "TEST", revision: 1, code: "WELCOME", type: "percentage", value: 10, active: false, productIds: [], minimumSpend: 0, startsAt: null, endsAt: null };
  const requests: any[] = []; let fail = true;
  await mount({}, async (_url: string, options: any) => {
    if (options.method === "GET") return Response.json({ discounts: [record], products: [] });
    requests.push(JSON.parse(options.body));
    return fail ? Response.json({ error: "Save not confirmed", errorRef: "TEST-REF" }, { status: 503 }) : Response.json({ discount: { ...record, ...requests.at(-1), revision: 2 } });
  }, async doc => {
    await act(async () => click(doc, "OFF"));
    assert.equal(doc.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /Save not confirmed.*TEST-REF/);
    assert.equal(requests[0].expectedRevision, 1);
    fail = false; await act(async () => click(doc, "OFF"));
    assert.equal(doc.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "true");
    await act(async () => (doc.querySelector("article button") as HTMLButtonElement).click());
    await act(async () => fill(doc, "Discount code", "RENAMED"));
    fail = true; await act(async () => click(doc, "Save discount"));
    assert.equal(field(doc, "Discount code").value, "RENAMED");
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /Save not confirmed/);
  });
});
test("Framer discount requests use bearer authentication without requiring cross-site cookie CORS", async () => {
  const methods: string[] = [];
  await mount({ apiBaseUrl: "https://backend.example.test" }, async (url: string, options: any) => {
    assert.equal(url, "https://backend.example.test/api/admin/discounts");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers.Authorization, "Bearer TEST-NOT-A-REAL-SESSION");
    methods.push(options.method);
    if (options.method === "GET") return Response.json({ discounts: [], products: [] });
    return Response.json({ discount: { ...JSON.parse(options.body), id: "TEST", revision: 1 } });
  }, async doc => {
    assert.match(doc.body.textContent!, /No discounts yet/);
    await act(async () => click(doc, "Create discount"));
    await act(async () => { fill(doc, "Discount code", "TEST10"); fill(doc, "Percentage off", "10"); });
    await act(async () => click(doc, "Save discount"));
    assert.match(doc.querySelector("article")?.textContent || "", /TEST10.*10% off/);
    assert.equal(doc.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
  }, "TEST-NOT-A-REAL-SESSION");
  assert.deepEqual(methods, ["GET", "POST"]);
});
