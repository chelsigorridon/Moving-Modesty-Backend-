/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated React DOM test harness. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
async function harness(file: string, props: any, check: (doc: Document, button: (text: string) => void) => Promise<void>) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://example.invalid/review" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], configurable: true });
  const exports: any = {};
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { exports, require, structuredClone, FormData: dom.window.FormData, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement });
  const root = require("react-dom/client").createRoot(dom.window.document.getElementById("root"));
  function button(text: string) { const node = [...dom.window.document.querySelectorAll("button")].find(node => node.textContent === text); assert.ok(node, `Missing button ${text}`); node.click(); }
  try { await act(async () => root.render(React.createElement(exports.default, props))); await check(dom.window.document, button); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
}
const address = { company: "", line1: "10 Example Street", line2: "Unit A", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" };
const plan = { version: 1, collection: { kind: "door", contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" }, address },
  delivery: { kind: "door", contact: { name: "TEST Customer", email: "customer@example.invalid", phone: "0827654321" }, address: { ...address, line1: "20 Customer Street" } },
  collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false };
test("delivery starts with compact address summaries and confirms existing values without reopening twenty fields", async () => {
  const saved: any[] = [];
  await harness("../components/delivery-editor.tsx", { details: { revision: 0, plan: null, draftPlan: plan, privateNote: "", canEdit: true }, save: async (value: any) => saved.push(value), searchPoints: async () => ({ points: [] }) }, async (doc, button) => {
    assert.equal(doc.querySelector('[name="collection.line1"]'), null); assert.equal(doc.querySelector('[name="delivery.line1"]'), null);
    assert.match(doc.body.textContent || "", /10 Example Street.*20 Customer Street/);
    assert.equal(doc.querySelector('.mm-delivery__private')?.hasAttribute("open"), false);
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => button("Confirm delivery details"));
    assert.equal(saved.length, 1); assert.equal(saved[0].confirmed, true);
    assert.equal(saved[0].plan.collection.address.line1, address.line1); assert.equal(saved[0].plan.delivery.address.line1, "20 Customer Street");
  });
});
test("editing only one address preserves the other and reads silent autofill from its own form", async () => {
  const saved: any[] = [];
  await harness("../components/delivery-editor.tsx", { details: { revision: 0, plan, draftPlan: plan, privateNote: "", canEdit: true }, save: async (value: any) => saved.push(value), searchPoints: async () => ({ points: [] }) }, async (doc, button) => {
    await act(async () => button("Change customer delivery"));
    assert.equal(doc.querySelector('[name="collection.line1"]'), null);
    (doc.querySelector('[name="delivery.line1"]') as HTMLInputElement).value = "30 Autofilled Street";
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => button("Save delivery details"));
    assert.equal(saved.length, 1); assert.equal(saved[0].plan.delivery.address.line1, "30 Autofilled Street");
    assert.equal(saved[0].plan.collection.address.line1, address.line1);
  });
});
test("a saved package fills dimensions but never sets weight; custom measurements stay available", async () => {
  let value = { weightGrams: "412", lengthCm: "", widthCm: "", heightCm: "" }, loads = 0;
  await harness("../components/parcel-editor.tsx", { value, change: (next: any) => { value = next; }, loadPackages: async () => { loads++; return [{ id: "test", name: "TEST Flyer", lengthCm: 40, widthCm: 32, heightCm: 6 }]; } }, async (doc, button) => {
    assert.equal(loads, 0, "Render never calls Bob Go");
    await act(async () => button("Load my saved Bob Go packages"));
    const select = doc.querySelector("select")!;
    await act(async () => { select.value = "test"; select.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true })); });
    assert.equal(value.lengthCm, "40"); assert.equal(value.widthCm, "32"); assert.equal(value.heightCm, "6"); assert.equal(value.weightGrams, "412");
    await act(async () => button("Change dimensions")); assert.equal(doc.querySelectorAll('input[type="number"]').length, 4);
  });
});
