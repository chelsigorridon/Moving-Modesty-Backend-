/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated React/browser fixtures; no live sessions, emails or providers. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const portalSource = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
const componentSource = readFileSync(new URL("../components/technical-alerts.tsx", import.meta.url), "utf8");
const alert = { id: "TEST-alert", reference: "TEST-reference", orderNumber: null, source: "admin", operation: "admin_login", code: "unexpected", summary: "An unexpected application error interrupted the operation.",
  severity: "error", environment: "production", httpStatus: null, occurrences: 1, firstSeenAt: "2026-10-16T09:32:20.014Z", lastSeenAt: "2026-10-16T09:32:20.014Z", resolvedAt: null };
const responseData = (incidents: any[] = [alert], page = 0, hasMore = false) => ({ incidents, counts: { open: 1, resolved: 0 }, pagination: { page, pageSize: 50, hasMore } });
async function harness(check: (ctx: any) => Promise<void>, options: any = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://store.test.invalid/admin/orders", runScripts: "outside-only" });
  const win = dom.window as any, original = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  win.Error = Error;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.require = (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name);
  win.exports = {};
  win.fetch = options.fetch || (() => { throw new Error("Live requests forbidden"); });
  win.sessionStorage.setItem("moving_modesty_admin_token", "TEST-only-fake-session");
  win.eval(ts.transpileModule(options.portal ? portalSource : componentSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText);
  const root = require("react-dom/client").createRoot(win.document.getElementById("root"));
  const calls: any[] = [], loads: any[] = [];
  const props: any = options.portal ? { view: "orders", apiBaseUrl: "https://api.test.invalid" } : {
    close: () => { calls.push("close"); },
    load: async (status: string, page: number) => { loads.push({ status, page }); return options.load ? options.load(status, page) : responseData(); },
    resolve: async (incident: any) => { calls.push(incident); return options.resolve?.(incident); },
  };
  const doc = win.document;
  async function click(text: string) { const node = [...doc.querySelectorAll('button')].find((node: any) => node.textContent === text); assert.ok(node, `Missing button ${text}`); await act(async () => node.click()); }
  const button = (text: string) => [...doc.querySelectorAll('button')].find((node: any) => node.textContent === text) as HTMLButtonElement;
  async function render(next = props) { await act(async () => root.render(React.createElement(win.exports.default, next))); }
  async function reviewed() { await click("Review alert"); await act(async () => (doc.querySelector('input[type="checkbox"]') as HTMLInputElement).click()); await click("Mark as resolved"); }
  try { await render(); await check({ doc, win, calls, loads, click, button, reviewed, render, props, root }); }
  finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
}

test("alerts open read-only, translate operation names and show SAST dates with details behind Review", async () => {
  await harness(async ({ doc, click, calls, loads }) => {
    assert.deepEqual(loads, [{ status: "open", page: 0 }]); assert.equal(calls.length, 0);
    assert.match(doc.body.textContent, /Admin sign-in/); assert.match(doc.body.textContent, /11:32 SAST/);
    assert.equal(doc.querySelector('input[type="checkbox"]'), null);
    await click("Review alert");
    assert.equal(doc.activeElement, doc.querySelector('.mm-admin__alert-detail h3'));
    assert.equal(doc.querySelector('details')?.open, false);
    assert.match(doc.body.textContent, /TEST-reference/); assert.match(doc.body.textContent, /General website alert/);
    assert.equal(calls.length, 0);
  });
});
test("resolution requires review, an explicit confirmation and never submits twice", async () => {
  let complete: () => void;
  await harness(async ({ doc, click, button, calls }) => {
    await click("Review alert"); assert.equal(button("Mark as resolved").disabled, true);
    await click("Mark as resolved"); assert.equal(calls.length, 0);
    await act(async () => doc.querySelector('input[type="checkbox"]').click());
    await click("Mark as resolved"); assert.equal(calls.length, 0);
    await click("Keep open"); assert.equal(calls.length, 0);
    await click("Mark as resolved");
    await click("Confirm resolution"); await click("Resolving…");
    assert.equal(calls.length, 1); assert.equal(calls[0].id, alert.id);
    assert.equal(button("Close").disabled, true);
    const cancel = new doc.defaultView.Event("cancel", { cancelable: true });
    doc.querySelector('dialog').dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true);
    await act(async () => complete!());
    assert.match(doc.body.textContent, /Alert marked as resolved/);
  }, { resolve: () => new Promise<void>(done => { complete = done; }) });
});
test("a conflict or failed resolution leaves the alert open and demands a fresh review", async () => {
  await harness(async ({ doc, reviewed, click, button, calls, loads }) => {
    await reviewed(); await click("Confirm resolution");
    assert.equal(calls.length, 1); assert.match(doc.querySelector('[role="alert"]').textContent, /happened again/);
    assert.equal(button("Mark as resolved").disabled, true); assert.equal(doc.querySelector('input').checked, false);
    await click("Refresh and review"); assert.equal(loads.length, 2);
    assert.equal(doc.querySelector('.mm-admin__alert-detail'), null);
  }, { resolve: () => { throw new Error("This alert happened again. Refresh and review it."); } });
});
test("resolved history is read-only; filters, empty states, refresh and pagination work", async () => {
  await harness(async ({ doc, click, loads }) => {
    await click("Next"); assert.equal(loads.at(-1).page, 1);
    await click("Previous"); assert.equal(loads.at(-1).page, 0);
    await click("Resolved (0)"); assert.equal(loads.at(-1).status, "resolved");
    await click("Review alert"); assert.equal(doc.querySelector('.mm-admin__alert-resolution'), null);
    assert.match(doc.body.textContent, /Resolved/);
    await click("Refresh alerts"); assert.equal(doc.querySelector('.mm-admin__alert-detail'), null);
    await click("Open (1)");
  }, { load: (status: string, page: number) => responseData(status === "resolved" ? [{ ...alert, resolvedAt: "2026-10-17T10:00:00Z" }] : [alert], page, status === "open" && page === 0) });
  await harness(async ({ doc, calls }) => { assert.match(doc.body.textContent, /No open alerts/); assert.equal(calls.length, 0); }, { load: () => responseData([]) });
});
test("loading failures are not an empty healthy state and retries are read-only", async () => {
  let attempt = 0;
  await harness(async ({ doc, click, calls }) => {
    assert.match(doc.querySelector('[role="alert"]').textContent, /could not be loaded/);
    assert.doesNotMatch(doc.body.textContent, /No open alerts|PRIVATE SQL/);
    await click("Refresh and review"); assert.match(doc.body.textContent, /Admin sign-in/); assert.equal(calls.length, 0);
  }, { load: () => { if (!attempt++) throw new Error("PRIVATE SQL"); return responseData(); } });
});
test("late loads after a filter change cannot restore stale alerts", async () => {
  let oldResult: (value: any) => void;
  await harness(async ({ doc, click }) => {
    await click("Resolved"); assert.match(doc.body.textContent, /No resolved alerts/);
    await act(async () => oldResult!(responseData([alert])));
    assert.doesNotMatch(doc.body.textContent, /Admin sign-in/);
  }, { load: (status: string) => status === "open" ? new Promise(done => { oldResult = done; }) : responseData([]) });
});
test("Account and the banner open the actual bundled screen; only the diagnostics endpoint can be patched", async () => {
  const requests: any[] = []; let resolved = false;
  await harness(async ({ doc, click, button }) => {
    assert.deepEqual(requests.map(item => item.path), ["/api/admin/data"]);
    await click("Technical alerts"); assert.equal(doc.querySelector('dialog[open] h2').textContent, "Technical alerts");
    assert.equal(requests.filter(item => item.method === "PATCH").length, 0);
    await click("Review alert"); await act(async () => doc.querySelector('.mm-admin__alerts input').click());
    await click("Mark as resolved"); await click("Confirm resolution");
    const patches = requests.filter(item => item.method === "PATCH"); assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { id: alert.id, expectedOccurrences: 1, confirmed: true });
    assert.equal(patches[0].path, "/api/admin/diagnostics");
    assert.ok(requests.filter(item => item.path === "/api/admin/data").length >= 2);
    assert.equal(button("Review technical alerts"), undefined, "The banner is re-read from the server after resolution");
    assert.ok(requests.every(item => ["/api/admin/data", "/api/admin/diagnostics"].includes(item.path)));
    await click("Close"); assert.equal(doc.activeElement, doc.querySelector('.mm-admin__account > summary'));
  }, { portal: true, fetch: async (url: string, init: any = {}) => {
    const path = new URL(url).pathname, method = init.method || "GET";
    assert.equal(init.headers.Authorization, "Bearer TEST-only-fake-session");
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/admin/data") return Response.json({ orders: [], ...(!resolved ? { operationalNotice: "A website service needs attention." } : {}) });
    assert.equal(path, "/api/admin/diagnostics");
    if (method === "PATCH") { resolved = true; return Response.json({ resolved: true }); }
    return Response.json(responseData(resolved ? [] : [alert]));
  } });
});
test("the shared screen is bundled exactly, supports mobile wrapping and has no live review route", () => {
  const embedded = portalSource.split("// BEGIN_MM_TECHNICAL_ALERTS\n")[1]?.split("// END_MM_TECHNICAL_ALERTS")[0]?.trim();
  const expected = componentSource.replace(/^"use client";\s*/m, "").replace(/^import[^\n]+from "react";\s*/m, "")
    .replace("export default function TechnicalAlerts", "function EmbeddedTechnicalAlerts").replace(/^export (?=const\b)/gm, "").trim();
  assert.equal(embedded, expected);
  assert.match(componentSource, /min-height:44px/); assert.match(componentSource, /overflow-wrap:anywhere/);
  assert.match(componentSource, /@media\(max-width:420px\)/); assert.match(componentSource, /Africa\/Johannesburg/);
  assert.match(readFileSync(new URL("../app/technical-alerts-review/page.tsx", import.meta.url), "utf8"), /NODE_ENV !== "development" \|\| process.env.VERCEL_ENV/);
});
