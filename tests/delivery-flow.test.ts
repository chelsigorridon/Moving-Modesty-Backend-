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
  runInNewContext(compiled, { exports, require: (name: string) => ["../lib/shipping/owner-measurements", "../lib/shipping/collection-schedule"].includes(name) ? require(`${name}.ts`) : require(name), structuredClone, Error, FormData: dom.window.FormData, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement });
  const root = require("react-dom/client").createRoot(dom.window.document.getElementById("root"));
  function button(text: string) { const node = [...dom.window.document.querySelectorAll("button")].find(node => node.textContent === text); assert.ok(node, `Missing button ${text}`); node.click(); }
  async function rerender(next: any) { await act(async () => root.render(React.createElement(exports.default, next))); }
  try { await rerender(props); await check(dom.window.document, button, rerender); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
}
const address = { company: "", line1: "10 Example Street", line2: "Unit A", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" };
const plan = { version: 1, collection: { kind: "door", contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" }, address },
  delivery: { kind: "door", contact: { name: "TEST Customer", email: "customer@example.invalid", phone: "0827654321" }, address: { ...address, line1: "20 Customer Street" } },
  collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false, collectionSchedule: { date: "2099-07-16", after: "09:00", before: "16:00" } };
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
    await act(async () => button("Edit delivery address"));
    assert.equal(doc.querySelector('[name="collection.line1"]'), null);
    (doc.querySelector('[name="delivery.line1"]') as HTMLInputElement).value = "30 Autofilled Street";
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => button("Save delivery details"));
    assert.equal(saved.length, 1); assert.equal(saved[0].plan.delivery.address.line1, "30 Autofilled Street");
    assert.equal(saved[0].plan.collection.address.line1, address.line1);
  });
});
test("visible delivery method buttons open setup without provider requests or saving an incomplete locker", async () => {
  const writes: any[] = [], edits: boolean[] = []; let searches = 0;
  await harness("../components/delivery-editor.tsx", { details: { revision: 1, plan, draftPlan: plan, privateNote: "", canEdit: true },
    save: async (value: any) => writes.push(value), searchPoints: async () => { searches++; return { points: [] }; }, onEditingChange: (value: boolean) => edits.push(value) }, async (doc, button) => {
    const groups = [...doc.querySelectorAll('.mm-delivery__method-choices')];
    assert.equal(groups.length, 1); assert.equal(groups.flatMap(group => [...group.querySelectorAll('button')]).length, 2);
    for (const group of groups) assert.equal(group.querySelectorAll('[aria-pressed="true"]').length, 1);
    await act(async () => button("Zarina drops off at a locker / counter"));
    assert.equal((doc.querySelector('[name="collection.kind"]') as HTMLSelectElement).value, "pickup_point");
    assert.equal(doc.querySelector('[name="delivery.kind"]'), null, "The customer's delivery must not be silently changed");
    assert.equal(searches, 0); assert.equal(writes.length, 0); assert.deepEqual(edits, [true]);
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => doc.querySelector('fieldset')!.closest('form')!.dispatchEvent(new doc.defaultView!.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 0, "A pickup point must be explicitly selected before saving");
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /Choose each pickup point/);
    await act(async () => button("Cancel editing"));
    assert.equal(doc.querySelectorAll('.mm-delivery__method-choices').length, 1); assert.deepEqual(edits, [true, false]);
  });
});

test("selecting an existing drop-off preserves its verified point and leaves customer door delivery unchanged", async () => {
  const pickupPlan = { ...plan, collectionSchedule: undefined, collection: { kind: "pickup_point", contact: plan.collection.contact, point: { id: "91001", providerSlug: "demo", name: "DEMO Locker" } } };
  const writes: any[] = [];
  await harness("../components/delivery-editor.tsx", { details: { revision: 4, plan: pickupPlan, draftPlan: pickupPlan, privateNote: "", canEdit: true }, save: async (value: any) => writes.push(value), searchPoints: async () => ({ points: [] }) }, async (doc, button) => {
    await act(async () => button("Zarina drops off at a locker / counter"));
    assert.match(doc.querySelector('.mm-delivery__selected-point')?.textContent || "", /DEMO Locker/);
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => button("Save delivery details"));
    assert.equal(writes.length, 1); assert.equal(writes[0].plan.collection.point.id, "91001");
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].plan.delivery)), plan.delivery);
    assert.equal(writes[0].rememberCollection, false, "Changing this order must not opt into updating future orders");
  });
});

test("customer pickup is not offered, legacy pickup must be corrected to a home address, and booked orders stay locked", async () => {
  const pickupPlan = { ...plan, delivery: { kind: "pickup_point", contact: plan.delivery.contact, point: { id: "91002", providerSlug: "demo", name: "DEMO Counter" } }, customerApprovedPickup: true };
  const writes: any[] = [];
  const props = { details: { revision: 2, plan: pickupPlan, draftPlan: pickupPlan, privateNote: "", canEdit: true }, save: async (value: any) => writes.push(value), searchPoints: async () => ({ points: [] }) };
  await harness("../components/delivery-editor.tsx", props, async (doc, button, rerender) => {
    assert.equal([...doc.querySelectorAll('button')].some(node => node.textContent === "Customer collects at a locker / counter"), false);
    await act(async () => button("Edit delivery address"));
    assert.equal(doc.querySelector('[name="delivery.kind"]'), null);
    assert.equal(doc.querySelector('[name="delivery.search"]'), null);
    assert.equal(doc.querySelector('[name="approvedPickup"]'), null);
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => doc.querySelector('fieldset')!.closest('form')!.dispatchEvent(new doc.defaultView!.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 0); assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /home delivery address/);
    await act(async () => button("Enter customer’s home address"));
    assert.ok(doc.querySelector('[name="delivery.line1"]'));
    await rerender({ ...props, details: { ...props.details, canEdit: false, blockedReason: "This waybill is booked." } });
    assert.equal(doc.querySelector('.mm-delivery__method-choices'), null);
  });
});
test("a saved package fills dimensions but never sets weight; custom measurements stay available", async () => {
  let value = { weightGrams: "412", lengthCm: "", widthCm: "", heightCm: "" }, loads = 0;
  await harness("../components/parcel-editor.tsx", { value, change: (next: any) => { value = next; }, loadPackages: async () => { loads++; return [{ id: "test", name: "TEST Flyer", lengthCm: 40, widthCm: 32, heightCm: 6 }]; } }, async (doc, button) => {
    assert.equal(loads, 0, "Render never calls Bob Go");
    const otherBoxes = [...doc.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Other saved boxes (optional)")!;
    assert.ok(otherBoxes); assert.equal(otherBoxes.open, false);
    await act(async () => (otherBoxes.querySelector("summary") as HTMLElement).click());
    assert.equal(loads, 0, "Opening optional box settings is not a provider request");
    await act(async () => button("Load saved Bob Go boxes"));
    const select = doc.querySelector("select")!;
    await act(async () => { select.value = "bobgo:test"; select.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true })); });
    assert.equal(value.lengthCm, "40"); assert.equal(value.widthCm, "32"); assert.equal(value.heightCm, "6"); assert.equal(value.weightGrams, "412");
    await act(async () => button("Change dimensions")); assert.equal(doc.querySelectorAll('input[type="number"]').length, 4);
  });
});

test("the collection schedule can be edited on its own, reads silent autofill, and cannot save reversed hours", async () => {
  const writes: any[] = [];
  await harness("../components/delivery-editor.tsx", { details: { revision: 3, plan, draftPlan: plan, privateNote: "", canEdit: true }, save: async (value: any) => writes.push(value), searchPoints: async () => ({ points: [] }) }, async (doc, button) => {
    await act(async () => button("Change collection date / time"));
    assert.equal(doc.querySelector('[name="collection.line1"]'), null); assert.equal(doc.querySelector('[name="delivery.line1"]'), null);
    assert.equal(doc.querySelector('[name="remember"]'), null, "A per-order schedule cannot silently become a sender default");
    (doc.querySelector('[name="collectionSchedule.date"]') as HTMLInputElement).value = "2099-07-17";
    (doc.querySelector('[name="collectionSchedule.after"]') as HTMLInputElement).value = "16:00";
    (doc.querySelector('[name="collectionSchedule.before"]') as HTMLInputElement).value = "15:00";
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => doc.querySelector('fieldset')!.closest('form')!.dispatchEvent(new doc.defaultView!.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 0); assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /end after the start/);
    (doc.querySelector('[name="collectionSchedule.after"]') as HTMLInputElement).value = "10:00";
    await act(async () => doc.querySelector('fieldset')!.closest('form')!.dispatchEvent(new doc.defaultView!.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].plan.collectionSchedule)), { date: "2099-07-17", after: "10:00", before: "15:00" });
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].plan.collection)), plan.collection);
    assert.equal(writes[0].rememberCollection, false);
  });
});

test("the Moving Modesty box works offline, preserves actual weight and stays available when Bob Go fails", async () => {
  let value = { weightGrams: "777", lengthCm: "", widthCm: "", heightCm: "" }, loads = 0;
  const props = { value, change: (next: any) => { value = next; }, loadPackages: async () => { loads++; throw new Error("DEMO outage"); } };
  await harness("../components/parcel-editor.tsx", props, async (doc, button, rerender) => {
    assert.equal(loads, 0);
    assert.match(doc.querySelector('select')?.textContent || "", /Moving Modesty scarf box.*25 × 20 × 3 cm/);
    await act(async () => { const select = doc.querySelector('select')!; select.value = "moving-modesty-scarf-box"; select.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true })); });
    assert.deepEqual(JSON.parse(JSON.stringify(value)), { weightGrams: "777", lengthCm: "25", widthCm: "20", heightCm: "3" });
    await rerender({ ...props, value });
    const weight = doc.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    assert.equal(weight.value, "777"); assert.equal(weight.disabled, false); assert.equal(weight.readOnly, false);
    await act(async () => ([...doc.querySelectorAll("summary")].find(node => node.textContent === "Other saved boxes (optional)") as HTMLElement).click());
    await act(async () => button("Load saved Bob Go boxes"));
    assert.equal(loads, 1); assert.ok(doc.querySelector('option[value="moving-modesty-scarf-box"]'));
    assert.match(doc.querySelector('option[value="393"]')?.textContent || "", /393 g/);
    assert.match(doc.body.textContent || "", /extra boxes must also be included/);
  });
});

test("packed weights are selectable, keep box dimensions and expose manual entry without reusing a preset silently", async () => {
  let value = { weightGrams: "", lengthCm: "25", widthCm: "20", heightCm: "3" }, loads = 0;
  const props = { value, change: (next: any) => { value = next; }, loadPackages: async () => { loads++; return []; } };
  await harness("../components/parcel-editor.tsx", props, async (doc, _button, rerender) => {
    const select = () => [...doc.querySelectorAll('select')].find(node => node.closest('label')?.textContent?.startsWith('Choose a packed weight'))!;
    const pick = async (choice: string) => {
      await act(async () => { select().value = choice; select().dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true })); });
      await rerender({ ...props, value });
    };
    assert.equal(select().value, ""); assert.equal(select().required, true);
    assert.equal(doc.querySelector('input[inputmode="numeric"]'), null);
    assert.equal([...doc.querySelectorAll('summary')].some(node => node.textContent === 'Need a weight guide?'), false);
    for (const weight of ["183", "200", "267", "305", "335", "393"]) {
      await pick(weight); assert.equal(value.weightGrams, weight);
      assert.deepEqual([value.lengthCm, value.widthCm, value.heightCm], ["25", "20", "3"]);
      assert.equal(doc.querySelector('input[inputmode="numeric"]'), null);
      assert.equal(Boolean(doc.querySelector('[role="status"]')), weight === "305");
    }
    await pick('manual'); assert.equal(value.weightGrams, "", 'Manual entry cannot accidentally keep the preset');
    assert.equal(select().value, 'manual');
    const input = doc.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    assert.equal(input.required, true); assert.equal(input.min, "1"); assert.equal(input.max, "30000");
    const setter = Object.getOwnPropertyDescriptor(doc.defaultView!.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '267'); input.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true })); });
    await rerender({ ...props, value });
    assert.equal(value.weightGrams, "267"); assert.equal(select().value, 'manual', 'A typed preset number must not hide the manual input');
    await pick('183'); assert.equal(value.weightGrams, "183");
    await rerender({ ...props, value, disabled: true });
    assert.equal(select().disabled, true); assert.equal(loads, 0, 'Weight selection is entirely local');
  });
});

test("linked collection hours are clearly labelled as a preferred driver note and remain editable", async () => {
  const writes: any[] = [];
  await harness("../components/delivery-editor.tsx", { guided: true, details: { revision: 3, plan, draftPlan: plan, privateNote: "", canEdit: true, collectionTimeMode: "preferred_instructions" }, save: async (value: any) => writes.push(value), searchPoints: async () => ({ points: [] }) }, async (doc, button) => {
    assert.match(doc.body.textContent || "", /Hours are sent as a preferred driver note, not a booked time slot/);
    await act(async () => button("Change collection date / time"));
    const section = doc.querySelector('[aria-label="Requested collection schedule"]')!;
    assert.match(section.textContent || "", /driver note, not a booked time slot/);
    assert.match(section.textContent || "", /Preferred from.*Preferred until/);
    assert.equal(doc.querySelector('[name="collectionSchedule.after"]')?.getAttribute("type"), "time");
    assert.equal(doc.querySelector('[name="remember"]'), null);
    (doc.querySelector('[name="collectionSchedule.after"]') as HTMLInputElement).value = "10:00";
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => doc.querySelector('fieldset')!.closest('form')!.dispatchEvent(new doc.defaultView!.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].plan.collectionSchedule.after, "10:00");
    assert.equal(writes[0].plan.collectionInstructions, "", "The backend adds the preference; saving the form must not accumulate generated notes");
  });
});

test("advanced delivery setup is collapsed for daily bookings but opens for an actionable problem", async () => {
  await harness("../components/delivery-advanced-settings.tsx", { children: "TEST product weights and sales-channel sync" }, async (doc, _button, rerender) => {
    const details = () => doc.querySelector("details")!;
    assert.equal(details().open, false);
    assert.equal(details().querySelector("summary")?.textContent, "Advanced settings");
    assert.equal(details().querySelector('p'), null, "Routine screens do not repeat setup explanations");
    await act(async () => (details().querySelector("summary") as HTMLElement).click());
    assert.equal(details().open, true, "Settings remain available through a named disclosure");
    await rerender({ children: "TEST connection needs attention", needsAttention: true });
    assert.equal(details().open, true);
    assert.match(details().querySelector("summary")?.textContent || "", /needs attention/);
  });
});

test("Zarina's weights are staged explicitly, preserve unknown variants, and save only product grams with optimistic baselines", async () => {
  let rows = [
    { id: "small", product: "Hawa Tri-Instant Scarf", colour: "Black", size: "Small", grams: null as number | null },
    { id: "large", product: "Hawa", colour: "Pink", size: "Large", grams: 140 },
    { id: "amina", product: "Amina Tie-Back", colour: "Lavender", size: "One size fits all", grams: null },
    { id: "unknown", product: "Future product", colour: "Example", size: "Large", grams: 999 },
  ];
  const writes: any[] = []; let reads = 0;
  await harness("../components/shipping-weight-settings.tsx", { request: async (changes?: any[]) => {
    if (!changes) { reads++; return rows; }
    writes.push(changes); rows = rows.map(row => ({ ...row, grams: changes.find(change => change.id === row.id)?.grams ?? row.grams })); return rows;
  } }, async (doc, button) => {
    assert.equal(reads, 0); assert.equal(writes.length, 0, "Rendering cannot write weights or enable sync");
    await act(async () => button("Load product weights"));
    await act(async () => button("Fill Zarina’s measured weights"));
    assert.equal(reads, 1); assert.equal(writes.length, 0);
    assert.deepEqual([...doc.querySelectorAll('input[type="number"]')].map(node => (node as HTMLInputElement).value), ["126", "145", "212", "999"]);
    assert.equal((doc.querySelector('[name="confirmed"]') as HTMLInputElement).checked, false);
    await act(async () => button("Save product weights")); assert.equal(writes.length, 0);
    await act(async () => (doc.querySelector('[name="confirmed"]') as HTMLInputElement).click());
    await act(async () => button("Save product weights"));
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), [[{ id: "small", expectedGrams: null, grams: 126 }, { id: "large", expectedGrams: 140, grams: 145 }, { id: "amina", expectedGrams: null, grams: 212 }]]);
    assert.match(doc.body.textContent || "", /Measured weights saved\./);
    assert.equal((doc.querySelector('[name="confirmed"]') as HTMLInputElement).checked, false);
  });
});
