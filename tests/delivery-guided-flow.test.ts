/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated React DOM and mocked courier transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const address = { company: "", line1: "10 Example Street", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" };
const plan = { version: 1, collection: { kind: "door", address, contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" } },
  delivery: { kind: "door", address: { ...address, line1: "20 Example Road" }, contact: { name: "TEST Buyer", email: "buyer@example.invalid", phone: "0827654321" } },
  collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false, collectionSchedule: { date: "2099-07-16", after: "09:00", before: "16:00" } };
function sample(overrides: any = {}) {
  return { id: "MM-GUIDED-TEST", address: "20 Example Road", paymentStatus: "Paid", status: "Ready", deliveryMethod: "Courier", deliveryFee: 99,
    deliveryDetails: { revision: 1, plan, draftPlan: plan, privateNote: "", canEdit: true },
    shipping: { status: "Ready to book", environment: "production", blockers: [] }, ...overrides };
}
async function harness(order: any, check: (ctx: any) => Promise<void>, provider?: (action: string, payload: any) => any) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://example.invalid/review" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], configurable: true });
  const exports: any = {};
  runInNewContext(`${compiled}\nexports.ShippingPanel = ShippingPanel;`, { exports, structuredClone, Error, FormData: dom.window.FormData,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    require: (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => true } : require(name) });
  const root = require("react-dom/client").createRoot(dom.window.document.getElementById("root"));
  const calls: any[] = [], confirmations: any[] = [];
  const props = { order, loading: false, connection: { enabled: true, configured: true, environment: "production" },
    requestShipping: async (_order: any, action: string, payload: any) => { calls.push({ action, payload }); return provider?.(action, payload) || {}; },
    confirm: (value: any) => confirmations.push(value) };
  const doc = dom.window.document;
  async function render(next: any = props) { await act(async () => root.render(React.createElement(exports.ShippingPanel, next))); }
  async function click(text: string) { const node = [...doc.querySelectorAll('button')].find(node => node.textContent === text); assert.ok(node, `Missing button: ${text}`); await act(async () => node.click()); }
  async function input(selector: string, value: string) {
    const node = doc.querySelector(selector) as HTMLInputElement; assert.ok(node, `Missing field ${selector}`);
    await act(async () => { Object.getOwnPropertyDescriptor(node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
  }
  const step = () => doc.querySelector('[data-delivery-step]')?.getAttribute("data-delivery-step");
  try { await render(); await check({ doc, click, input, calls, confirmations, step, render, props, dom }); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
}
const quotes = { environment: "production", expires: Date.now() + 600000, rates: [
  { providerName: "TEST A", serviceName: "Economy", serviceCode: "ECO", amount: 95, quoteToken: "mock-a" },
  { providerName: "TEST B", serviceName: "Express", serviceCode: "EXP", amount: 115, quoteToken: "mock-b" },
  { providerName: "TEST C", serviceName: "Standard", serviceCode: "STD", amount: 105, quoteToken: "mock-c" },
  { providerName: "TEST D", serviceName: "Road", serviceCode: "R", amount: 99, quoteToken: "mock-d" },
] };
async function compare(ctx: any) {
  await ctx.input('select[name="packedWeightPreset"]', "393");
  await act(async () => (ctx.doc.querySelector('.mm-admin__courier-check input') as HTMLInputElement).click());
  await ctx.click("Compare couriers");
}

test("a new order shows only delivery details, with all method choices available through Change", async () => {
  await harness(sample({ deliveryDetails: { revision: 0, plan: null, draftPlan: plan, privateNote: "", canEdit: true } }), async ({ doc, click, step, calls }) => {
    assert.equal(step(), "1"); assert.equal(doc.querySelectorAll('[data-delivery-step]').length, 1);
    assert.equal(doc.querySelector('.mm-admin__parcel-editor'), null); assert.equal(doc.querySelector('.mm-delivery__method-choices'), null);
    assert.equal(calls.length, 0);
    await click("Change collection");
    const method = doc.querySelector('select[name="collection.kind"]') as HTMLSelectElement;
    assert.deepEqual([...method.options].map(option => option.value), ["door", "pickup_point"]);
    assert.equal(doc.querySelector('[name="delivery.line1"]'), null);
    await click("Cancel editing"); assert.equal(step(), "1"); assert.equal(calls.length, 0);
  });
});

test("each slide shows one step without completed cards, and Back never contacts Bob Go", async () => {
  await harness(sample(), async ({ doc, step, click, calls }) => {
    assert.equal(step(), "2"); assert.equal(doc.querySelector('.mm-admin__delivery-editor'), null);
    assert.equal((doc.querySelector('select') as HTMLSelectElement).value, "moving-modesty-scarf-box");
    assert.equal((doc.querySelector('select[name="packedWeightPreset"]') as HTMLSelectElement).value, "");
    assert.equal(doc.querySelector('input[inputmode="numeric"]'), null);
    assert.equal(doc.querySelector('.mm-delivery__completed'), null);
    const change = doc.querySelector('[aria-label="Back to delivery details"]') as HTMLButtonElement;
    await act(async () => change.click()); assert.equal(step(), "1");
    assert.equal(doc.querySelector('.mm-admin__parcel-editor'), null);
    await click("Continue to parcel"); assert.equal(step(), "2"); assert.equal(calls.length, 0);
  });
});

test("quotes advance to one courier step, show every returned service and are invalidated by going back", async () => {
  await harness(sample(), async ctx => {
    await compare(ctx); assert.equal(ctx.step(), "3");
    assert.equal(ctx.doc.querySelector('.mm-admin__parcel-editor'), null);
    assert.equal(ctx.doc.querySelectorAll('.mm-admin__quote select option').length, 4);
    assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0].action, "quote");
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].payload)), { parcel: { weightGrams: 393, lengthCm: 25, widthCm: 20, heightCm: 3 }, additionalCover: false });
    await ctx.input('.mm-admin__quote select', "1");
    const review = [...ctx.doc.querySelectorAll('button')].find((node: any) => /^Review booking/.test(node.textContent)) as HTMLButtonElement;
    assert.match(review.textContent || "", /115/); await act(async () => review.click());
    assert.equal(ctx.confirmations.length, 1); assert.match(ctx.confirmations[0].description, /TEST B.*Express.*115/);
    assert.match(ctx.confirmations[0].description, /real waybill.*charge Zarina/);
    assert.equal(ctx.calls.length, 1, "Review is not booking");
    await act(async () => (ctx.doc.querySelector('[aria-label="Back to parcel"]') as HTMLButtonElement).click());
    assert.equal(ctx.step(), "2"); assert.equal(ctx.doc.querySelector('.mm-admin__quote'), null);
    assert.equal((ctx.doc.querySelector('select[name="packedWeightPreset"]') as HTMLSelectElement).value, "393");
    assert.equal((ctx.doc.querySelector('.mm-admin__courier-check input') as HTMLInputElement).checked, false);
    assert.equal(ctx.calls.length, 1);
  }, action => action === "quote" ? quotes : {});
});

test("failed quote leaves the parcel available, exposes a useful error and never books", async () => {
  await harness(sample(), async ctx => {
    await compare(ctx); assert.equal(ctx.step(), "2");
    assert.match(ctx.doc.querySelector('[role="alert"]')?.textContent || "", /TEST quote unavailable/);
    assert.deepEqual(ctx.calls.map((call: any) => call.action), ["quote"]);
    assert.ok([...ctx.doc.querySelectorAll('button')].find((node: any) => node.textContent === "Compare couriers"));
  }, () => { throw new Error("TEST quote unavailable. Try again."); });
});

test("an empty rate response explains the next action instead of silently returning to parcel", async () => {
  await harness(sample(), async ctx => {
    await compare(ctx); assert.equal(ctx.step(), "2");
    assert.match(ctx.doc.querySelector('[role="alert"]')?.textContent || "", /No courier services found/);
    assert.deepEqual(ctx.calls.map((call: any) => call.action), ["quote"]);
    assert.equal(ctx.confirmations.length, 0);
  }, () => ({ rates: [] }));
});

test("invalid packed weights cannot advance the slide or request quotes", async () => {
  await harness(sample(), async ctx => {
    await ctx.input('select[name="packedWeightPreset"]', "manual");
    for (const value of ["-1", "0", "0.5", "30001"]) {
      await ctx.input('input[inputmode="numeric"]', value);
      await act(async () => (ctx.doc.querySelector('.mm-admin__courier-check input') as HTMLInputElement).click());
      assert.equal(ctx.step(), "2");
      const button = [...ctx.doc.querySelectorAll('button')].find((node: any) => node.textContent === "Compare couriers") as HTMLButtonElement;
      assert.equal(button.disabled, true);
      await ctx.click("Compare couriers"); assert.equal(ctx.calls.length, 0);
    }
  });
});

test("booked deliveries show print and tracking first, with safe changes behind a disclosure", async () => {
  const booked = sample({ deliveryDetails: { revision: 2, plan, draftPlan: plan, privateNote: "TEST only", canEdit: false,
    waybillChange: { action: "cancel_waybill", trackingNumber: "TEST-WAYBILL" } },
    shipping: { status: "Booked", environment: "production", blockers: [], trackingNumber: "TEST-WAYBILL", courierName: "TEST A", trackingUrl: "https://example.invalid/track" } });
  await harness(booked, async ({ doc, step, calls, click, render, props }) => {
    assert.equal(step(), "4"); assert.equal(calls.length, 0); assert.equal(doc.querySelector('.mm-admin__parcel-editor'), null);
    const changes = [...doc.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === "Delivery details & changes")!;
    assert.ok(changes); assert.equal(changes.open, false);
    assert.equal((doc.querySelector('.mm-delivery__waybill-change button') as HTMLButtonElement).disabled, true);
    await click("Prepare printable waybill"); assert.deepEqual(calls.map((call: any) => call.action), ["waybill"]);
    assert.equal(doc.querySelector('a[href="https://example.invalid/TEST.pdf"]')?.textContent, "Print waybill PDF");
    await click("Check shipment status"); assert.equal(calls.at(-1).action, "refresh");
    await render({ ...props, order: { ...booked, deliveryDetails: { ...booked.deliveryDetails, waybillChange: { action: "check_cancellation", trackingNumber: "TEST-WAYBILL" } } } });
    assert.equal(step(), "1"); assert.ok([...doc.querySelectorAll('button')].find(node => node.textContent === "Check cancellation"));
    assert.equal(doc.querySelector('input[name="delivery.line1"]'), null);
    assert.equal(doc.querySelector('.mm-admin__parcel-editor'), null);
    assert.equal(calls.length, 2, "Status changes cannot request cancellation or book on render");
  }, action => action === "waybill" ? { url: "https://example.invalid/TEST.pdf" } : {});
});

test("the shared one-step layout is bundled once and both gates require explicit new-order activation", () => {
  assert.equal((source.match(/function EmbeddedDeliveryStepFlow\(/g) || []).length, 1);
  assert.doesNotMatch(source, /from ["']\.\/delivery-step-flow/);
  assert.match(source, /key=\{current\}/);
  assert.match(source, /@media\(prefers-reduced-motion:reduce\)/);
  for (const path of ["order-sync-policy", "linked-booking-policy"]) {
    const policy = readFileSync(new URL(`../lib/integrations/bobgo/${path}.ts`, import.meta.url), "utf8");
    assert.match(policy, /return newOrderConfiguration\("BOBGO_(?:ORDER_SYNC|LINKED_BOOKING)_ENABLED"\)/);
  }
});
