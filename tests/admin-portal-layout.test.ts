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
const componentExports: Record<string, React.ComponentType<Record<string, unknown>>> = {};
runInNewContext(`${compiled}\nexports.OrdersView = OrdersView; exports.DashboardView = DashboardView; exports.DeliverySettings = DeliverySettings;`, {
  exports: componentExports,
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
  for (const view of ["dashboard", "orders", "products"]) {
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
      ["Dashboard", "/admin"], ["Orders", "/admin/orders"], ["Products (CMS)", "/admin/products"],
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
  assert.equal(dom.window.document.querySelector('[aria-label="Next step"] button')?.textContent, "Book waybill");
  assert.match(dom.window.document.body.textContent || "", /Customer delivery fee:.*R\s*99/);
  assert.match(dom.window.document.body.textContent || "", /separate from Zarina's courier cost/);
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
