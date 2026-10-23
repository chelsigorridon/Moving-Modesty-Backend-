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
const basePlan = { version: 1, collection: { kind: "door", address, contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" } },
  delivery: { kind: "door", address: { ...address, line1: "20 Example Road" }, contact: { name: "TEST Buyer", email: "buyer@example.invalid", phone: "0827654321" } },
  collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false, collectionSchedule: { date: "2099-07-16", after: "09:00", before: "16:00" } };
const dropOff = { id: "1156", providerSlug: "ie", name: "Constantia Emporium" };
const plan = { ...basePlan, collectionOptions: { door: basePlan.collection, doorSchedule: basePlan.collectionSchedule, pickupPoint: { kind: "pickup_point", contact: basePlan.collection.contact, point: dropOff } } };
function sample(overrides: any = {}) {
  return { id: "MM-GUIDED-TEST", address: "20 Example Road", paymentStatus: "Paid", status: "Ready", deliveryMethod: "Courier", deliveryFee: 99,
    deliveryDetails: { revision: 1, plan, draftPlan: plan, privateNote: "", canEdit: true },
    shipping: { status: "Ready to book", environment: "production", blockers: [] }, ...overrides };
}
async function harness(order: any, check: (ctx: any) => Promise<void>, provider?: (action: string, payload: any, sourceOrder?: any) => any) {
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
    requestShipping: async (_order: any, action: string, payload: any) => { calls.push({ action, payload, order: _order }); const result = await provider?.(action, payload, _order) || {};
      if (action === "save_delivery" && result.order) { props.order = result.order; root.render(React.createElement(exports.ShippingPanel, props)); } return result; },
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

const saveAndQuote = (action: string, payload: any, order: any) => action === "save_delivery" ? { order: { ...order, deliveryDetails: { ...order.deliveryDetails, revision: order.deliveryDetails.revision + 1, plan: payload.plan, draftPlan: payload.plan } } } : action === "quote" ? { ...quotes, collectionDropOff: dropOff } : {};
test("new orders start at parcel and explicitly reuse saved sender and checkout details without address re-entry", async () => {
  await harness(sample({ deliveryDetails: { revision: 0, plan: null, draftPlan: plan, privateNote: "", canEdit: true } }), async ctx => {
    assert.equal(ctx.step(), "2"); assert.equal(ctx.doc.querySelectorAll('[data-delivery-step]').length, 1);
    assert.ok(ctx.doc.querySelector('.mm-admin__parcel-editor')); assert.equal(ctx.doc.querySelector('[name="collection.line1"]'), null);
    assert.equal(ctx.calls.length, 0); await compare(ctx);
    assert.equal(ctx.step(), "3"); assert.deepEqual(ctx.calls.map((c: any) => c.action), ["save_delivery", "quote"]);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].payload.plan.delivery)), plan.delivery);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].payload.plan.collectionOptions)), plan.collectionOptions);
  }, saveAndQuote);
});

test("each slide shows one step without completed cards, and Back never contacts Bob Go", async () => {
  await harness(sample(), async ({ doc, step, calls }) => {
    assert.equal(step(), "2"); assert.equal(doc.querySelector('.mm-admin__delivery-editor'), null);
    assert.equal((doc.querySelector('select') as HTMLSelectElement).value, "moving-modesty-scarf-box");
    assert.equal((doc.querySelector('select[name="packedWeightPreset"]') as HTMLSelectElement).value, "");
    assert.equal(doc.querySelector('input[inputmode="numeric"]'), null);
    assert.equal(doc.querySelector('.mm-delivery__completed'), null);
    assert.equal([...doc.querySelectorAll('button')].some(node => node.textContent === "Edit delivery details"), false);
    assert.equal(doc.querySelector('[aria-current="step"]')?.getAttribute('aria-label'), "Step 1 of 3: Parcel");
    assert.equal(calls.length, 0);
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
    await ctx.click("Back to parcel");
    assert.equal(ctx.step(), "2"); assert.equal(ctx.doc.querySelector('.mm-admin__quote'), null);
    assert.equal((ctx.doc.querySelector('select[name="packedWeightPreset"]') as HTMLSelectElement).value, "393");
    assert.equal((ctx.doc.querySelector('.mm-admin__courier-check input') as HTMLInputElement).checked, true);
    assert.equal(ctx.calls.length, 1);
  }, action => action === "quote" ? quotes : {});
});

test("failed quote keeps collection choices visible and exposes a retry without jumping backwards", async () => {
  await harness(sample(), async ctx => {
    await compare(ctx); assert.equal(ctx.step(), "3");
    assert.match(ctx.doc.querySelector('[role="alert"]')?.textContent || "", /TEST quote unavailable/);
    assert.deepEqual(ctx.calls.map((call: any) => call.action), ["quote"]);
    assert.ok([...ctx.doc.querySelectorAll('button')].find((node: any) => node.textContent === "Compare couriers"));
    assert.ok(ctx.doc.querySelector('[aria-label="How Zarina sends the parcel"]'));
  }, () => { throw new Error("TEST quote unavailable. Try again."); });
});

test("the visible edit buttons reach the customer address without provider calls, and cancelling preserves the parcel", async () => {
  await harness(sample(), async ctx => {
    await compare(ctx); assert.equal(ctx.step(), "3");
    const edit = [...ctx.doc.querySelectorAll('button')].find((node: HTMLButtonElement) => node.textContent === "Edit delivery address") as HTMLButtonElement;
    assert.ok(edit.classList.contains("mm-admin__secondary-button"));
    await ctx.click("Edit delivery address");
    assert.equal((ctx.doc.querySelector('[name="delivery.line1"]') as HTMLInputElement).value, "20 Example Road");
    assert.equal(ctx.doc.querySelector('[name="collection.line1"]'), null);
    assert.equal(ctx.doc.querySelector('button[type="submit"]')?.textContent, "Save delivery details");
    await ctx.click("Cancel editing");
    assert.equal(ctx.step(), "3"); assert.equal(ctx.doc.querySelector('[name="delivery.line1"]'), null);
    assert.equal(ctx.calls.length, 1); await ctx.click("Back to parcel");
    assert.equal((ctx.doc.querySelector('select[name="packedWeightPreset"]') as HTMLSelectElement).value, "393");
  }, saveAndQuote);
});

test("an empty rate response explains the next action instead of silently returning to parcel", async () => {
  await harness(sample(), async ctx => {
    await compare(ctx); assert.equal(ctx.step(), "3");
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

test("Constantia Emporium appears after courier comparison; choosing it changes only sender collection and requests a fresh locker-to-door price", async () => {
  await harness(sample(), async ctx => {
    assert.equal(ctx.doc.querySelector('[aria-label="How Zarina sends the parcel"]'), null);
    await compare(ctx);
    const choices = ctx.doc.querySelector('[aria-label="How Zarina sends the parcel"]');
    assert.ok(choices); assert.equal(choices.querySelectorAll('button').length, 2);
    assert.equal(choices.querySelectorAll('.mm-admin__secondary-button').length, 2, "Both options share the same style");
    assert.equal(choices.querySelector('[aria-pressed=true]')?.textContent, "Courier collects from Zarina");
    assert.ok(choices.compareDocumentPosition(ctx.doc.querySelector('.mm-admin__quote select')) & 4, "Choices come before the courier selector, not below booking");
    assert.match(ctx.doc.body.textContent || "", /Deliver to: 20 Example Road/);
    assert.equal(ctx.calls.length, 1);
    await ctx.click("Locker drop-off · Constantia Emporium");
    assert.deepEqual(ctx.calls.map((call: any) => call.action), ["quote", "save_delivery", "quote"]);
    const saved = ctx.calls[1].payload;
    assert.equal(saved.plan.collection.kind, "pickup_point"); assert.equal(saved.plan.collection.point.id, "1156");
    assert.equal(saved.plan.collectionSchedule, undefined); assert.equal(saved.plan.customerApprovedPickup, false);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.plan.delivery)), plan.delivery, "Never move the customer to a locker");
    assert.equal(saved.rememberCollection, false); assert.equal(saved.expectedRevision, 1);
    assert.equal(ctx.calls[2].order.deliveryDetails.revision, 2); assert.equal(ctx.calls[2].payload.parcel.weightGrams, 393);
    assert.equal(ctx.step(), "3"); assert.match(ctx.doc.body.textContent || "", /Drop off at Constantia Emporium/);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.plan.collectionOptions.door)), plan.collection);
    assert.equal(ctx.doc.querySelector('[aria-label="How Zarina sends the parcel"] [aria-pressed=true]')?.textContent, "Locker drop-off · Constantia Emporium");
    await ctx.click("Locker drop-off · Constantia Emporium");
    assert.equal(ctx.calls.length, 3, "Selecting the current method does nothing");
    assert.equal(ctx.confirmations.length, 0);
    const button = [...ctx.doc.querySelectorAll('button')].find((node: any) => /^Review booking/.test(node.textContent)) as HTMLButtonElement;
    await act(async () => button.click());
    assert.match(ctx.confirmations[0].description, /Drop-off at Constantia Emporium.*Delivery to 20 Example Road/);
    assert.equal(ctx.calls.length, 3, "Review never books");
    await ctx.click("Courier collects from Zarina");
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[3].payload.plan.collection)), plan.collection);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[3].payload.plan.collectionSchedule)), plan.collectionSchedule);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[3].payload.plan.delivery)), plan.delivery);
    assert.equal(ctx.calls[4].payload.parcel.weightGrams, 393); assert.equal(ctx.calls[4].order.deliveryDetails.revision, 3);
    assert.equal(ctx.calls.some((call: any) => call.action === "book"), false);
  }, (action, payload, order) => action === "save_delivery" ? { order: { ...order, deliveryDetails: { ...order.deliveryDetails, revision: order.deliveryDetails.revision + 1, plan: payload.plan, draftPlan: payload.plan } } }
    : action === "quote" ? { ...quotes, collectionDropOff: dropOff, ...(order.deliveryDetails.plan.collection.kind === "pickup_point" ? { rates: [{ ...quotes.rates[0], providerName: "TEST Locker Courier", serviceName: "Locker to door", amount: 85, quoteToken: "mock-locker-origin" }] } : {}) } : {});
});

test("failed drop-off choices never reuse a door quote, hide the choices or create a waybill", async () => {
  for (const mode of ["save-failed", "readback-missing", "quote-failed"]) {
    let count = 0;
    await harness(sample(), async ctx => {
      await compare(ctx); await ctx.click("Locker drop-off · Constantia Emporium");
      assert.equal(ctx.step(), "3"); assert.ok(ctx.doc.querySelector('.mm-admin__quote')); assert.equal(ctx.doc.querySelector('.mm-admin__quote select'), null); assert.ok(ctx.doc.querySelector('[role="alert"]'));
      assert.equal(ctx.calls.filter((call: any) => call.action === "save_delivery").length, 1);
      assert.equal(ctx.calls.filter((call: any) => call.action === "quote").length, mode === "quote-failed" ? 2 : 1);
      assert.equal(ctx.confirmations.length, 0); assert.equal(ctx.calls.some((call: any) => call.action === "book"), false);
    }, (action, payload, order) => {
      if (action === "quote") { if (++count > 1) throw new Error("TEST drop-off rate unavailable"); return { ...quotes, collectionDropOff: dropOff, expires: Date.now() + 600000 }; }
      if (mode === "save-failed") throw new Error("TEST locker unavailable");
      return mode === "readback-missing" ? {} : { order: { ...order, deliveryDetails: { ...order.deliveryDetails, revision: 2, plan: payload.plan, draftPlan: payload.plan } } };
    });
  }
});

test("reopening a saved locker order still restores the collection address and this order's date without re-entry", async () => {
  await harness(sample(), async ctx => {
    await compare(ctx); await ctx.click("Locker drop-off · Constantia Emporium");
    const stored = JSON.parse(JSON.stringify(ctx.props.order));
    Object.assign(ctx.props, { key: "reopened", order: stored }); await ctx.render();
    assert.equal(ctx.step(), "2");
    await compare(ctx); await ctx.click("Courier collects from Zarina");
    assert.equal(ctx.step(), "3"); assert.equal(ctx.doc.querySelector('[name="collection.line1"]'), null);
    const saved = ctx.calls.filter((call: any) => call.action === "save_delivery").at(-1).payload.plan;
    assert.deepEqual(JSON.parse(JSON.stringify(saved.collection)), plan.collection);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.collectionSchedule)), plan.collectionSchedule);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.delivery)), plan.delivery);
    assert.equal(ctx.calls.some((call: any) => call.action === "book"), false);
  }, saveAndQuote);
});

test("a missing collection window asks only for the date in place; locker drop-off does not need one", async () => {
  const noDate = { ...plan, collectionSchedule: undefined, collectionOptions: { ...plan.collectionOptions, doorSchedule: undefined } };
  await harness(sample({ deliveryDetails: { revision: 1, plan: noDate, draftPlan: noDate, privateNote: "", canEdit: true } }), async ctx => {
    await compare(ctx); assert.equal(ctx.step(), "3"); assert.equal(ctx.calls.length, 0);
    assert.ok(ctx.doc.querySelector('[name="collectionSchedule.date"]'));
    assert.equal(ctx.doc.querySelector('[name="collection.line1"]'), null);
    assert.equal(ctx.doc.querySelector('[name="delivery.line1"]'), null);
    await ctx.click("Locker drop-off · Constantia Emporium");
    assert.equal(ctx.step(), "3"); assert.equal(ctx.doc.querySelector('[name="collectionSchedule.date"]'), null);
    assert.deepEqual(ctx.calls.map((call: any) => call.action), ["save_delivery", "quote"]);
    assert.equal(ctx.calls[0].payload.plan.collectionSchedule, undefined);
    assert.equal(ctx.calls[1].payload.parcel.weightGrams, 393);
  }, saveAndQuote);
});

test("inline address saves preserve the other address, parcel and both methods, and refresh quotes in place", async () => {
  for (const side of ["collection", "delivery"]) {
    await harness(sample(), async ctx => {
      await compare(ctx); await ctx.click(side === "collection" ? "Edit collection details" : "Edit delivery address");
      assert.equal(ctx.calls.length, 1);
      assert.equal((ctx.doc.querySelector(`[name="${side}.line1"]`) as HTMLInputElement).value, plan[side as "collection" | "delivery"].address.line1);
      await ctx.input(`[name="${side}.line1"]`, "30 Updated Street");
      await act(async () => ctx.doc.querySelector('.mm-admin__delivery-editor form').dispatchEvent(new ctx.dom.window.Event("submit", { bubbles: true, cancelable: true })));
      assert.equal(ctx.step(), "3"); assert.equal(ctx.doc.querySelector(`[name="${side}.line1"]`), null);
      assert.deepEqual(ctx.calls.map((call: any) => call.action), ["quote", "save_delivery", "quote"]);
      const changed = ctx.calls[1].payload.plan, opposite = side === "collection" ? "delivery" : "collection";
      assert.equal(changed[side].address.line1, "30 Updated Street");
      assert.deepEqual(JSON.parse(JSON.stringify(changed[opposite])), plan[opposite]);
      assert.equal(changed.collectionOptions.pickupPoint.point.id, "1156");
      assert.equal(ctx.calls[2].payload.parcel.weightGrams, 393);
      assert.equal(ctx.calls[1].payload.confirmed, true);
      assert.equal(ctx.calls[1].payload.rememberCollection, false);
      assert.equal(ctx.calls.some((call: any) => call.action === "book"), false);
    }, saveAndQuote);
  }
});
