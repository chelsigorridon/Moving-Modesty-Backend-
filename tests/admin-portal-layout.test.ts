import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

test("bundled product editor keeps customer-facing labels out of identifier renaming", () => {
  const portal = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
  const generated = portal.slice(portal.indexOf("// BEGIN GENERATED PRODUCT EDITOR"));
  assert.match(generated, /type CatalogueDraft =/);
  assert.match(generated, /type CatalogueColour =/);
  assert.match(generated, /"Draft"/);
  assert.match(generated, /Colour names and their images/);
  assert.doesNotMatch(generated, /"CatalogueDraft"|CatalogueColour names|CataloguePhoto uploaded/);
});
const componentExports: Record<string, React.ComponentType<Record<string, unknown>>> = {};
runInNewContext(`${compiled}\nexports.OrdersView = OrdersView; exports.DashboardView = DashboardView; exports.DeliverySettings = DeliverySettings;`, {
  exports: componentExports,
  structuredClone,
  require: (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => true } : require(name),
});

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "MM-TEST-LAYOUT", customer: "TEST Customer", email: "test@example.com", phone: "0820000000",
    placedAt: "05 Oct, 12:00", total: 420, deliveryFee: 0, paymentStatus: "Paid", status: "Ready",
    deliveryMethod: "Collection", items: [{ quantity: 1, name: "Amina", variant: "Lavender", price: 420 }],
    workflow: { nextStatus: "Collected", actionLabel: "Mark collected", guidance: "Arrange collection with the customer.", canCancel: true },
    ...overrides,
  };
}

function ordersDocument(selected: ReturnType<typeof order>) {
  const props = {
    orders: [selected], selected, selectedOrderId: selected.id, filter: "Needs attention", search: "", method: "All methods",
    loading: false, bobGoConnection: { environment: "production", enabled: true, configured: true },
    setSelectedOrderId() {}, setFilter() {}, setSearch() {}, setMethod() {},
    updateOrderStatus() { throw new Error("Rendering must not change orders"); },
    requestShipping() { throw new Error("Rendering must not book shipping"); },
    requestAftersales() { throw new Error("Rendering must not record refunds or returns"); },
    retryNotification() {},
  };
  return new JSDOM(renderToStaticMarkup(React.createElement(componentExports.OrdersView, props)));
}

test("orders have three compact views and no global courier setup controls", () => {
  const dom = ordersDocument(order());
  const doc = dom.window.document;
  assert.deepEqual([...doc.querySelectorAll('[aria-label="Order filters"] button')].map(button => button.textContent),
    ["Needs attention", "In progress", "All orders"]);
  assert.equal(doc.querySelector('.mm-admin__extra-filter')?.hasAttribute("open"), false);
  assert.equal(doc.querySelector('.mm-admin__store-tools'), null);
  assert.doesNotMatch(doc.body.textContent || "", /Courier connection & setup|Check courier connection/);
  assert.equal(doc.querySelector('.mm-admin__order-card-top strong')?.textContent, "TEST Customer");
  assert.equal(doc.querySelector('.mm-admin__detail-heading h2')?.textContent, "TEST Customer");
  dom.window.close();
});

test("per-order troubleshooting stays behind one collapsed disclosure without new action buttons", () => {
  const selected = order();
  const requestTrace = () => { throw new Error("Rendering must not fetch a support trace"); };
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(componentExports.OrdersView, {
    orders: [selected], selected, selectedOrderId: selected.id, filter: "All orders", search: "", method: "All methods",
    loading: false, requestTrace, setSelectedOrderId() {}, setFilter() {}, setSearch() {}, setMethod() {},
    updateOrderStatus() {}, requestShipping() {}, requestAftersales() {}, retryNotification() {},
  })));
  const section = dom.window.document.querySelector(".mm-admin__support-trace");
  assert.equal(section?.querySelector("summary")?.textContent, "Support details");
  assert.equal(section?.hasAttribute("open"), false);
  assert.equal(section?.querySelectorAll("button").length, 0);
  assert.match(section?.textContent || "", /does not send emails, change the order or book delivery/);
  dom.window.close();
});

test("action-needed notices explain bounced emails without extra retry or technical buttons", () => {
  const dom = ordersDocument(order({
    actionNeeded: [{ message: "An email notification needs attention." }],
    notifications: [{ id: "TEST", title: "Ready for collection", recipient: "test@example.com", status: "failed", deliveryEvent: "email.bounced", deliveryMessage: "Contact the customer to confirm their email address.", retryable: false, createdAt: "2026-10-05" }],
  }));
  assert.match(dom.window.document.querySelector('[aria-label="Action needed"]')?.textContent || "", /email notification/);
  assert.match(dom.window.document.body.textContent || "", /Contact the customer/);
  assert.doesNotMatch(dom.window.document.body.textContent || "", /Retry email|no longer appropriate/);
  dom.window.close();
});

function settingsDocument(overrides: Record<string, unknown> = {}) {
  return new JSDOM(renderToStaticMarkup(React.createElement(componentExports.DeliverySettings, {
    open: false, close() {}, connection: { environment: "production", enabled: true, configured: true },
    check: { status: "unchecked" }, checking: false, disabled: false,
    checkConnection() { throw new Error("Rendering must not call Bob Go"); }, ...overrides,
  })));
}

test("Account opens delivery settings without adding an everyday courier button", () => {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(componentExports.default, { view: "orders" })));
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.mm-admin__account-menu button[aria-haspopup="dialog"]')?.textContent, "Delivery settings");
  assert.equal(doc.querySelector('dialog[aria-labelledby="mm-delivery-settings-title"]')?.hasAttribute("open"), false);
  assert.equal(doc.querySelector('.mm-admin__store-tools'), null);
  dom.window.close();
});

test("every admin page has one top-level responsive menu with all page destinations", () => {
  for (const view of ["dashboard", "orders", "products", "discounts"]) {
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(componentExports.default, { view })));
    const doc = dom.window.document;
    const menu = doc.querySelector('.mm-admin__utilities .mm-admin__responsive-nav');
    assert.ok(menu, `${view} needs navigation before its content`);
    const trigger = menu.querySelector('button[aria-controls="mm-admin-navigation"]');
    assert.equal(trigger?.textContent, "Menu");
    assert.equal(trigger?.getAttribute("aria-expanded"), "false");
    assert.equal(menu.querySelector('nav')?.hasAttribute("hidden"), true);
    assert.equal(doc.querySelectorAll('nav[aria-label="Admin navigation"]').length, 1);
    assert.deepEqual([...menu.querySelectorAll('nav a')].map(link => [link.textContent, link.getAttribute("href")]), [
      ["Dashboard", "/admin"], ["Orders", "/admin/orders"], ["Products", "/admin/products"], ["Discounts", "/admin/discounts"],
    ]);
    assert.equal(menu.querySelector('a[aria-current="page"]')?.getAttribute("href"),
      view === "dashboard" ? "/admin" : `/admin/${view}`);
    assert.match(doc.querySelector('style')?.textContent || "", /@media \(width < 768px\).*mm-admin__responsive-nav \{ display: contents; \}/);
    assert.doesNotMatch(doc.querySelector('style')?.textContent || "", /min-width: 768px.*mm-admin__nav/);
    dom.window.close();
  }
});

test("login does not show authenticated navigation or account controls", () => {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(componentExports.default, { view: "login" })));
  assert.equal(dom.window.document.querySelector('.mm-admin__responsive-nav'), null);
  assert.equal(dom.window.document.querySelector('.mm-admin__account'), null);
  dom.window.close();
});

test("configured courier is not reported as connected before verification", () => {
  const dom = settingsDocument();
  const doc = dom.window.document;
  assert.match(doc.querySelector('[aria-label="Courier connection status"]')?.textContent || "", /Configured · not checked yet/);
  assert.equal(doc.querySelector('details')?.hasAttribute("open"), false);
  assert.match(doc.body.textContent || "", /does not book a shipment or create a courier charge/);
  assert.doesNotMatch(doc.body.textContent || "", /Confirm LIVE courier booking|Get courier quote/);
  dom.window.close();
});

test("delivery settings show verified connection and actionable errors separately", () => {
  const connected = settingsDocument({ check: { status: "connected", location: "Constantia Emporium", checkedAt: "05 Oct, 14:00", message: "Manual booking is enabled." } });
  assert.match(connected.window.document.querySelector('[aria-label="Courier connection status"]')?.textContent || "", /Connected[\s\S]*Constantia Emporium[\s\S]*Manual booking is enabled[\s\S]*Last checked:/);
  connected.window.close();
  const failed = settingsDocument({ check: { status: "error", message: "Drop-off point could not be verified." } });
  assert.match(failed.window.document.querySelector('[role="alert"]')?.textContent || "", /Drop-off point could not be verified/);
  failed.window.close();
});

test("account checks do not claim locker availability or enabled order synchronisation", () => {
  const dom = settingsDocument({ check: { status: "connected", location: "Collection and delivery are chosen per order", message: "Account access verified." } });
  assert.match(dom.window.document.body.textContent || "", /read-only Bob Go account access, not locker availability, courier quotes or order synchronisation/);
  assert.doesNotMatch(dom.window.document.body.textContent || "", /Drop-off point:/);
  dom.window.close();
});

test("paid collection shows one clear next action and no delivery booking panel", () => {
  const dom = ordersDocument(order());
  const doc = dom.window.document;
  assert.equal(doc.querySelector('[aria-label="Next step"] button')?.textContent, "Mark collected");
  assert.doesNotMatch(doc.querySelector('article[aria-label^="Details for"]')?.textContent || "", /Bob Go delivery/);
  assert.match(doc.body.textContent || "", /Message the customer privately/);
  assert.equal(doc.querySelector('details > summary')?.textContent, "Filter by delivery or collection");
  dom.window.close();
});

test("ready paid delivery has a prominent waybill action and separates customer and courier costs", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", deliveryFee: 99, workflow: { nextStatus: null },
    shipping: { status: "Ready to book", senderLocationName: "Constantia Emporium", environment: "production", blockers: [] } }));
  assert.equal(dom.window.document.querySelector('[aria-label="Next step"] button')?.textContent, "Set up delivery");
  assert.match(dom.window.document.body.textContent || "", /Delivery included in the customer's order total:.*R\s*99/);
  assert.equal(dom.window.document.querySelector('[data-delivery-step]')?.getAttribute('data-delivery-step'), "2");
  assert.equal(dom.window.document.querySelector('.mm-admin__quote'), null, "Courier costs appear only after a quote");
  assert.doesNotMatch(dom.window.document.body.textContent || "", /Customer delivery fee|Zarina's courier cost/);
  dom.window.close();
});

test("free delivery wording does not imply a fixed R99 customer charge", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", subtotal: 1260, total: 1260, deliveryFee: 0,
    shipping: { status: "Ready to book", senderLocationName: "Constantia Emporium", environment: "production", blockers: [] } }));
  const panel = dom.window.document.querySelector('[aria-label^="Book this order"] > section')!;
  assert.match(dom.window.document.body.textContent || "", /Delivery included in the customer's order total:.*Free/);
  assert.doesNotMatch(panel.textContent || "", /R\s*99|fixed R99/);
  dom.window.close();
});

test("unpaid orders describe delivery as part of the order total without claiming payment", () => {
  const dom = ordersDocument(order({ paymentStatus: "Pending payment", status: "New", deliveryMethod: "Courier", deliveryFee: 99,
    workflow: { nextStatus: null, guidance: "Wait for payment." }, shipping: { status: "Not ready" } }));
  assert.match(dom.window.document.body.textContent || "", /Delivery included in the customer's order total:.*R\s*99/);
  assert.doesNotMatch(dom.window.document.body.textContent || "", /Delivery paid by the customer/);
  dom.window.close();
});

test("courier preparation has one measurements confirmation and no optional extra-cover control", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", subtotal: 450, deliveryFee: 99,
    shipping: { status: "Ready to book", senderLocationName: "Constantia Emporium", environment: "production", blockers: [],
      weightGrams: 412, lengthCm: 25, widthCm: 20.5, heightCm: 3.5 } }));
  const panel = dom.window.document.querySelector('[aria-label^="Book this order"] > section')!;
  assert.ok(panel);
  assert.equal(panel.querySelectorAll('input[type="checkbox"]').length, 1);
  assert.match(panel.textContent || "", /Dimensions and packed weight checked/);
  assert.equal(panel.querySelector('.mm-admin__quote'), null);
  assert.doesNotMatch(panel.textContent || "", /Request additional declared-value cover|cover for.*450/);
  assert.equal([...panel.querySelectorAll('button')].find(button => button.textContent === "Compare couriers")?.hasAttribute('disabled'), true);
  dom.window.close();
});

test("the real quote click handler sends no additional cover and the backend resolves zero declared value", () => {
  const source = readFileSync(new URL('../framer/AdminPortal.tsx', import.meta.url), 'utf8');
  const handlers = [...source.matchAll(/await run\("quote", (.*), (?:sourceOrder|saved\.order)\)/g)].map(match => match[1]);
  assert.equal(handlers.length, 2, 'Check the ordinary comparison and inline-edit re-quote payloads');
  assert.match(source, /onClick=\{\(\) => \{ void comparePlan\(\)/);
  const calls: Array<{ action: string; payload: { parcel: Record<string, number>; additionalCover: boolean } }> = [];
  for (const handler of handlers) {
  const click = new Function('parcel', 'run', 'setQuote', `return () => { setQuote(null); void run("quote", ${handler}); }`)(
    { weightGrams: '412', lengthCm: '25', widthCm: '20.5', heightCm: '3.5' },
    (action: string, payload: { parcel: Record<string, number>; additionalCover: boolean }) => calls.push({ action, payload }),
    () => {},
  );
  click();
  assert.ok(calls.length > 0);
  assert.equal(calls[0].action, 'quote');
  assert.deepEqual(calls[0].payload, { parcel: { weightGrams: 412, lengthCm: 25, widthCm: 20.5, heightCm: 3.5 }, additionalCover: false });
  assert.deepEqual(calls.at(-1)?.payload, calls[0].payload);
  }
  const shipping = readFileSync(new URL('../lib/integrations/bobgo/shipping.ts', import.meta.url), 'utf8');
  const expression = shipping.match(/const declaredValue = (.*);/)?.[1];
  assert.ok(expression);
  assert.equal(new Function('additionalCover', 'data', `return (${expression});`)(calls[0].payload.additionalCover, { order: { subtotal: '450.00' } }), 0);
});

test("already-booked waybills retain their status, print and tracking controls", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", status: "Dispatched",
    shipping: { status: "Booked", senderLocationName: "Constantia Emporium", environment: "production", blockers: [],
      waybillReference: "TEST-EXISTING", trackingUrl: "https://tracking.example.com/TEST-EXISTING" } }));
  const panel = dom.window.document.querySelector('[aria-label^="Book this order"] > section')!;
  assert.ok(panel);
  assert.match(panel.textContent || "", /Booked/);
  assert.match(panel.textContent || "", /Prepare printable waybill|Check shipment status/);
  assert.equal(panel.querySelector('a[href="https://tracking.example.com/TEST-EXISTING"]')?.textContent, 'Track parcel');
  assert.doesNotMatch(panel.textContent || "", /Get delivery quote|Request additional/);
  assert.equal(panel.querySelector('input[type="checkbox"]'), null);
  dom.window.close();
});

const deliveryPlan = { version: 1, collection: { kind: "door", contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" },
  address: { company: "", line1: "10 Example Street", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" } },
  delivery: { kind: "door", contact: { name: "TEST Buyer", email: "buyer@example.invalid", phone: "0821234567" },
    address: { company: "", line1: "20 Example Road", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" } },
  collectionInstructions: "", deliveryInstructions: "Use bell", customerApprovedPickup: false, collectionSchedule: { date: "2099-07-16", after: "09:00", before: "16:00" } };

test("saved sender and checkout details start at parcel without an unnecessary address confirmation screen", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", subtotal: 450, deliveryFee: 99,
    deliveryDetails: { revision: 0, plan: null, draftPlan: deliveryPlan, privateNote: "", canEdit: true },
    shipping: { status: "Ready to book", senderLocationName: "Old fixed locker", environment: "production", blockers: [] } }));
  const editor = dom.window.document.querySelector('[aria-label="Delivery setup and notes"]');
  assert.equal(editor, null);
  assert.ok(dom.window.document.querySelector('.mm-admin__parcel-editor'));
  assert.equal(dom.window.document.querySelector('[name="collection.line1"]'), null);
  assert.equal(dom.window.document.querySelector('[name="delivery.line1"]'), null);
  const quote = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === "Compare couriers");
  assert.equal(quote?.disabled, true, "Parcel measurements and their confirmation are required before comparison");
  assert.doesNotMatch(dom.window.document.body.textContent || "", /Drop-off: Old fixed locker/);
  dom.window.close();
});

test("booked delivery exposes private notes and an honest provider amendment handoff, never a fake edit", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", status: "Dispatched",
    deliveryDetails: { revision: 2, plan: deliveryPlan, draftPlan: deliveryPlan, privateNote: "Private TEST note", canEdit: false,
      blockedReason: "This waybill is booked. Changes must be confirmed in Bob Go." },
    shipping: { status: "Booked", environment: "production", blockers: [] } }));
  const editor = dom.window.document.querySelector('[aria-label="Delivery setup and notes"]')!;
  assert.ok(editor.querySelector('textarea[name="privateNote"]'));
  assert.equal(editor.querySelector('textarea')?.textContent, "Private TEST note");
  assert.equal(editor.querySelector('a[href="https://my.bobgo.co.za/"]')?.textContent, "Open Bob Go to arrange the change");
  assert.doesNotMatch([...editor.querySelectorAll('button')].map(button => button.textContent).join(" "), /Edit delivery|Set up delivery/);
  assert.match(editor.textContent || "", /does not change the waybill/);
  dom.window.close();
});

test("before-handover waybill changes are explicit, confirmed, and cannot masquerade as an address edit", () => {
  for (const action of ["cancel_waybill", "check_cancellation", "prepare_replacement"] as const) {
    const dom = ordersDocument(order({ deliveryMethod: "Courier", status: "Ready",
      deliveryDetails: { revision: 4, plan: deliveryPlan, draftPlan: deliveryPlan, privateNote: "", canEdit: false,
        blockedReason: action === "prepare_replacement" ? "This waybill is cancelled." : "This waybill is booked.",
        waybillChange: { action, trackingNumber: "TEST-WAYBILL" } },
      shipping: { status: action === "prepare_replacement" ? "Cancelled" : "Booked", environment: "production", blockers: [] } }));
    const editor = dom.window.document.querySelector('[aria-label="Delivery setup and notes"]')!;
    const form = editor.querySelector(".mm-delivery__waybill-change")!;
    const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    assert.ok(button);
    assert.equal(button.disabled, action !== "check_cancellation");
    assert.equal(Boolean(form.querySelector('input[type="checkbox"][required]')), action !== "check_cancellation");
    assert.match(dom.window.document.getElementById(button.getAttribute('aria-describedby')!)?.textContent || "", action === "check_cancellation" ? /safely check again/ : /Tick the confirmation/);
    if (action === "cancel_waybill") {
      assert.ok(button.classList.contains("mm-delivery__danger-button"));
      assert.equal(form.parentElement?.tagName, "DETAILS");
      assert.equal(form.parentElement?.hasAttribute("open"), false);
      assert.equal(form.parentElement?.querySelector("summary")?.textContent, "Change address or courier");
    } else {
      assert.ok(button.classList.contains("mm-delivery__primary-action"));
      const summary = editor.querySelector(".mm-delivery__summary")!;
      assert.ok(form.compareDocumentPosition(summary) & 4, "Recovery action appears before the repeated address summaries");
    }
    assert.doesNotMatch([...editor.querySelectorAll('button')].map(button => button.textContent).join(" "), /Edit delivery address|Change collection/);
    if (action === "check_cancellation") assert.doesNotMatch(dom.window.document.body.textContent || "", /Prepare printable waybill|Download the waybill, attach/);
    dom.window.close();
  }
});

test("previous waybills are reference-only and remain separate from current delivery setup", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", status: "Ready",
    deliveryDetails: { revision: 5, plan: null, draftPlan: deliveryPlan, privateNote: "", canEdit: true,
      previousWaybills: [{ trackingNumber: "OLD-CANCELLED", courierName: "Old courier", status: "Cancelled", replacedAt: "2026-10-17T08:00:00.000Z" }] },
    shipping: { status: "Not ready", environment: "production", blockers: [] } }));
  const history = dom.window.document.querySelector(".mm-delivery__history")!;
  assert.equal(history.hasAttribute("open"), false);
  assert.match(history.textContent || "", /OLD-CANCELLED/);
  assert.equal(history.querySelector('a,button'), null);
  assert.match(history.textContent || "", /Do not use these labels/);
  assert.ok(dom.window.document.querySelector('.mm-admin__parcel-editor'));
  dom.window.close();
});

test("booked courier and service are shown without confusing account connection with order sync", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", status: "Dispatched", bobGoSync: { status: "Not enabled", message: "Order synchronisation is not activated." },
    shipping: { status: "Booked", courierName: "TEST Other Courier", serviceName: "Express", courierStatus: "in-transit", environment: "production", blockers: [] } }));
  const body = dom.window.document.body.textContent || "";
  assert.match(body, /TEST Other Courier · Express/);
  assert.match(body, /Courier status: in transit/);
  assert.match(body, /Sales-channel sync: Not enabled/);
  const sync = dom.window.document.querySelector('details[aria-label="Bob Go order synchronisation"]')!;
  assert.equal(sync.hasAttribute("open"), false);
  assert.equal(sync.closest(".mm-delivery__advanced")?.hasAttribute("open"), false);
  assert.equal(sync.closest(".mm-delivery__advanced")?.querySelector("summary")?.textContent, "Advanced settings");
  assert.match(sync.querySelector("summary")?.textContent || "", /Not enabled/);
  assert.doesNotMatch(body, /Activate sync|Sync now|Repeat payment notification/);
  dom.window.close();
});

test("delivery next steps and progress reflect booking and replacement states, not generic booking advice", () => {
  for (const [shipmentStatus, action, label, current] of [
    ["Ready to book", undefined, "Continue delivery setup", "Parcel"],
    ["Booking", undefined, "Check booking status", "Choose & book"],
    ["Booked", undefined, "Print & track waybill", "Print & track"],
    ["Booked", "check_cancellation", "Check cancellation", "Check details"],
    ["Cancelled", "prepare_replacement", "Prepare replacement", "Check details"],
    ["Cancelled", undefined, "Review cancelled waybill", "Check details"],
  ] as const) {
    const dom = ordersDocument(order({ deliveryMethod: "Courier", workflow: { nextStatus: shipmentStatus === "Booked" && !action ? "Dispatched" : null, guidance: "Old generic booking advice" },
      deliveryDetails: { revision: 2, plan: deliveryPlan, draftPlan: deliveryPlan, privateNote: "", canEdit: shipmentStatus === "Ready to book",
        ...(action ? { waybillChange: { action, trackingNumber: "TEST-WAYBILL" } } : {}) },
      shipping: { status: shipmentStatus, environment: "production", blockers: [] } }));
    const doc = dom.window.document;
    const next = doc.querySelector('[aria-label="Next step"]')!;
    assert.equal(next.querySelector("button")?.textContent, label);
    assert.doesNotMatch(next.textContent || "", /Old generic booking advice/);
    const paused = current === "Check details";
    assert.deepEqual([...doc.querySelectorAll('[aria-label="Delivery steps"] li')].map(node => node.textContent),
      paused ? ["1Check details", "2Box & weight", "3Choose & book", "4Print & track"] : ["1Parcel", "2Choose & book", "3Print & track"]);
    assert.equal(doc.querySelector('[aria-label="Delivery steps"] [aria-current="step"]')?.textContent, `${current === "Choose & book" ? 2 : current === "Print & track" ? 3 : 1}${current}`);
    if (action) assert.equal(doc.querySelector('[aria-label="Delivery steps"] [data-complete="true"]'), null, "Paused recovery must not look completed");
    dom.window.close();
  }
});

test("missing confirmed tracking keeps the backend's check-first guidance, including legacy bookings", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", workflow: { nextStatus: null, guidance: "The booking has no confirmed tracking number yet. Check shipment status before dispatching or notifying the customer." },
    deliveryDetails: { revision: 0, plan: null, draftPlan: deliveryPlan, privateNote: "", canEdit: false },
    shipping: { status: "Booked", environment: "production", blockers: [] } }));
  const next = dom.window.document.querySelector('[aria-label="Next step"]')!;
  assert.equal(next.querySelector("button")?.textContent, "Check shipment status");
  assert.match(next.textContent || "", /no confirmed tracking number/);
  assert.doesNotMatch(next.textContent || "", /Mark dispatched only/);
  assert.equal(dom.window.document.querySelector('[aria-label="Delivery steps"] [aria-current="step"]')?.textContent, "3Print & track");
  dom.window.close();
});

test("booked delivery summaries retain addresses and folded contact details while technical problems remain visible", () => {
  const dom = ordersDocument(order({ deliveryMethod: "Courier", bobGoSync: { status: "Needs attention", message: "Check the channel connection." },
    deliveryDetails: { revision: 0, plan: deliveryPlan, draftPlan: deliveryPlan, privateNote: "", canEdit: false },
    shipping: { status: "Booked", environment: "production", blockers: [] } }));
  const doc = dom.window.document;
  for (const card of doc.querySelectorAll('.mm-delivery__address-card')) {
    assert.match(card.querySelector("p")?.textContent || "", /Example/);
    const contact = card.querySelector('details')!;
    assert.equal(contact.hasAttribute("open"), false);
    assert.equal(contact.querySelector("summary")?.textContent, "Contact details");
    assert.match(contact.textContent || "", /example.invalid/);
  }
  assert.equal(doc.querySelectorAll('.mm-delivery__address-card').length, 2);
  assert.equal([...doc.querySelectorAll('button')].some(button => button.textContent === "Confirm delivery details"), false);
  assert.equal(doc.querySelector('details[aria-label="Bob Go order synchronisation"]')?.hasAttribute("open"), true, "A sync problem must not be silently hidden");
  assert.equal(doc.querySelector(".mm-delivery__advanced")?.hasAttribute("open"), true, "Advanced settings must also open so the problem remains visible");
  dom.window.close();
});

test("notification history reports submission honestly and only offers retries for eligible failures", () => {
  const dom = ordersDocument(order({ notifications: [
    { id: "1", title: "Payment", recipient: "test@example.com", status: "sent", retryable: false },
    { id: "2", title: "Collection", recipient: "test@example.com", status: "failed", retryable: true },
    { id: "3", title: "Outdated", recipient: "test@example.com", status: "failed", retryable: false },
  ] }));
  const doc = dom.window.document;
  assert.match(doc.body.textContent || "", /Submitted means the email provider accepted it, not that it reached the inbox/);
  assert.equal(doc.querySelectorAll('.mm-admin__notifications button').length, 1);
  assert.equal(doc.querySelector('.mm-admin__notifications')?.closest('details')?.hasAttribute('open'), true);
  assert.doesNotMatch(doc.body.textContent || "", /Resend payment email/);
  dom.window.close();
});

test("unpaid delivery cannot expose preparation or shipment actions", () => {
  const dom = ordersDocument(order({
    paymentStatus: "Failed", status: "New", deliveryMethod: "Courier", shipping: { status: "Not ready" },
    workflow: { nextStatus: null, actionLabel: "", guidance: "Resolve payment first.", canCancel: false },
  }));
  const doc = dom.window.document;
  assert.equal(doc.querySelector('[aria-label="Next step"] button'), null);
  assert.equal(doc.querySelector('article[aria-label^="Details for"] details > summary')?.textContent, "Payment details");
  assert.doesNotMatch(doc.body.textContent || "", /More order options|Get courier quote|Review & confirm/);
  dom.window.close();
});

test("dashboard keeps one order-management action without duplicate handover cards", () => {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(componentExports.DashboardView, {
    snapshot: { orders: [order()], paymentEnvironment: "production" },
  })));
  assert.equal(dom.window.document.querySelectorAll('a.mm-admin__button-link[href="/admin/orders"]').length, 1);
  assert.equal(dom.window.document.querySelector('.mm-admin__quick-grid'), null);
  assert.equal(dom.window.document.querySelector('details')?.hasAttribute("open"), false);
  dom.window.close();
});

const returnedItem = { id: "aa8e51b8-10b0-43a2-a15d-1eeb9c4fbdb5", quantity: 1, name: "Amina", variant: "Black", price: 420, returnableQuantity: 1, restockableQuantity: 0 };
const baseAftersales = { canStartReturn: false, canRecordRefund: false, refundedTotal: 0, remainingRefundable: 420, returns: [], refunds: [] };

test("return controls stay inside completed orders, collapsed until needed", () => {
  const dom = ordersDocument(order({ status: "Delivered", items: [returnedItem], aftersales: { ...baseAftersales, canStartReturn: true }, workflow: { canCancel: false } }));
  const panel = dom.window.document.querySelector('.mm-admin__aftersales')!;
  assert.equal(panel.hasAttribute("open"), false);
  assert.match(panel.textContent || "", /Approve a return/);
  assert.doesNotMatch(panel.textContent || "", /Record a completed refund|Save received items/);
  assert.equal(panel.querySelector('input[type="number"]')?.getAttribute('max'), "1");
  assert.equal(panel.querySelector('textarea')?.hasAttribute("required"), true);
  assert.equal(dom.window.document.querySelector('[aria-label="Order filters"]')?.textContent?.includes("Refund"), false);
  dom.window.close();
});

test("approved returns require a separate manual waybill and actual receipt before a refund", () => {
  const dom = ordersDocument(order({ status: "Delivered", items: [returnedItem], aftersales: { ...baseAftersales, returns: [{ id: "TEST", status: "approved", reason: "Agreed return", items: [{ itemId: returnedItem.id, quantity: 1, restocked: 0 }] }] } }));
  const panel = dom.window.document.querySelector('.mm-admin__aftersales')!;
  assert.equal(panel.hasAttribute("open"), true);
  assert.equal(panel.querySelector('a')?.getAttribute('href'), "https://app.bobgo.co.za/");
  assert.match(panel.textContent || "", /private return address/);
  assert.match(panel.textContent || "", /does not book or pay/);
  assert.match(panel.textContent || "", /No recorded stock deduction/);
  assert.equal(panel.querySelector('input[type="number"]')?.hasAttribute('disabled'), true);
  assert.equal(panel.querySelector('button[type="submit"].mm-admin__button')?.hasAttribute('disabled'), true);
  assert.doesNotMatch(panel.textContent || "", /Record a completed refund/);
  dom.window.close();
});

test("cancelled paid orders offer recording a completed refund, not an automatic refund button", () => {
  const dom = ordersDocument(order({ status: "Cancelled", items: [returnedItem], aftersales: { ...baseAftersales, canRecordRefund: true }, workflow: { canCancel: false } }));
  const panel = dom.window.document.querySelector('.mm-admin__aftersales')!;
  assert.match(panel.textContent || "", /Refund the customer in PayFast first/);
  assert.equal(panel.querySelector('a')?.getAttribute('href'), "https://my.payfast.io/");
  assert.equal(panel.querySelector('input[type="number"]')?.getAttribute('max'), "420");
  assert.equal(panel.querySelector('input[type="checkbox"]')?.hasAttribute('required'), true);
  assert.equal(panel.querySelector('button[type="submit"]')?.hasAttribute('disabled'), true);
  dom.window.close();
});

test("refund history is visible after a full refund without another refund action", () => {
  const dom = ordersDocument(order({ paymentStatus: "Refunded", status: "Cancelled", aftersales: { ...baseAftersales, refundedTotal: 420, remainingRefundable: 0,
    refunds: [{ id: "TEST", amount: 420, reference: "PF-TEST", reason: "Agreed cancellation", refundedAt: "2026-10-05", recordedBy: "Owner" }] }, workflow: { canCancel: false } }));
  const panel = dom.window.document.querySelector('.mm-admin__aftersales')!;
  assert.match(panel.textContent || "", /Refund history.*PF-TEST/);
  assert.match(panel.textContent || "", /not an automatic PayFast refund-status check/);
  assert.equal(panel.querySelector('button'), null);
  dom.window.close();
});
