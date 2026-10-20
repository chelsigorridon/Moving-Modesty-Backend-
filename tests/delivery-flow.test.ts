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
async function harness(file: string, props: any, check: (doc: Document, button: (text: string) => void, rerender: (next: any) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://example.invalid/review" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], configurable: true });
  const exports: any = {};
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { exports, require, structuredClone, Error, FormData: dom.window.FormData, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement });
  const root = require("react-dom/client").createRoot(dom.window.document.getElementById("root"));
  function button(text: string) { const node = [...dom.window.document.querySelectorAll("button")].find(node => node.textContent === text); assert.ok(node, `Missing button ${text}`); node.click(); }
  async function rerender(next: any) { await act(async () => root.render(React.createElement(exports.default, next))); }
  try { await rerender(props); await check(dom.window.document, button, rerender); }
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

test("waybill recovery requires current consent, explains its disabled action, and never runs on render", async () => {
  for (const action of ["cancel_waybill", "prepare_replacement"]) {
    const calls: any[] = [];
    const details = { revision: 4, plan, draftPlan: plan, privateNote: "", canEdit: false, waybillChange: { action, trackingNumber: "TEST-WAYBILL" } };
    const props = { details, save: async () => {}, searchPoints: async () => ({ points: [] }), changeWaybill: async (value: any) => { calls.push(value); } };
    await harness("../components/delivery-editor.tsx", props, async (doc, button, rerender) => {
      const label = action === "cancel_waybill" ? "Cancel this waybill" : "Prepare replacement";
      const submit = () => doc.querySelector('.mm-delivery__waybill-change button') as HTMLButtonElement;
      assert.equal(calls.length, 0);
      assert.equal(submit().disabled, true);
      assert.match(doc.getElementById(submit().getAttribute("aria-describedby")!)?.textContent || "", /Tick the confirmation/);
      await act(async () => button(label));
      assert.equal(calls.length, 0, "A disabled button must not submit");
      await act(async () => (doc.querySelector('.mm-delivery__waybill-change input') as HTMLInputElement).click());
      assert.equal(submit().disabled, false);
      await rerender({ ...props, details: { ...details, revision: 5 } });
      assert.equal(submit().disabled, true, "Consent for an old delivery revision cannot be reused");
      await act(async () => (doc.querySelector('.mm-delivery__waybill-change input') as HTMLInputElement).click());
      await act(async () => button(label));
      assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ action, expectedRevision: 5, expectedWaybill: "TEST-WAYBILL", confirm: true }]);
      assert.equal(submit().disabled, true, "A completed request consumes the checkbox consent");
    });
  }
});

test("checking a pending cancellation is explicit and surfaces provider errors beside that action", async () => {
  let checks = 0;
  await harness("../components/delivery-editor.tsx", {
    details: { revision: 3, plan, draftPlan: plan, privateNote: "", canEdit: false, waybillChange: { action: "check_cancellation", trackingNumber: "TEST-WAYBILL" } },
    save: async () => {}, searchPoints: async () => ({ points: [] }), changeWaybill: async () => { checks++; throw new Error("DEMO: cancellation is not confirmed. Check again later."); },
  }, async (doc, button) => {
    const form = doc.querySelector('.mm-delivery__waybill-change')!;
    assert.equal(checks, 0, "Render cannot check or change a real shipment");
    assert.equal(form.querySelector('input[type="checkbox"]'), null);
    await act(async () => button("Check cancellation"));
    assert.equal(checks, 1);
    assert.match(form.querySelector('[role="alert"]')?.textContent || "", /not confirmed/);
    assert.equal(doc.querySelector('input[name="delivery.line1"]'), null, "A failed check must not unlock address editing");
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
