/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated browser fixture; no live login or credentials. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText + "\nexports.LoginView = LoginView;";
const stub = (name: string) => name === "framer" ? { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } : require(name);

test("login keeps the password masked by default with an accessible, non-submitting eye button", () => {
  const mod = { exports: {} as any };
  new Function("require", "exports", compiled)(stub, mod.exports);
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(mod.exports.LoginView, { liveEnabled: false, backendConfigured: true })));
  try {
    const password = dom.window.document.querySelector('input[autocomplete="current-password"]')!;
    const toggle = dom.window.document.querySelector('button[aria-label="Show password"]')!;
    assert.equal(password.getAttribute("type"), "password");
    assert.equal(toggle.getAttribute("type"), "button");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), password.id);
    assert.equal(dom.window.document.querySelector(`label[for="${password.id}"]`)?.textContent, "Password");
    assert.equal(toggle.querySelector("svg")?.getAttribute("aria-hidden"), "true");
    assert.equal(password.getAttribute("autocapitalize"), "none");
    assert.equal(password.getAttribute("spellcheck"), "false");
    assert.equal(dom.window.document.querySelectorAll('button[type="submit"]').length, 1);
  } finally { dom.window.close(); }
});

test("show/hide preserves silently autofilled text and the same input, without submitting or calling the backend", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://store.test.invalid/admin/login", runScripts: "outside-only" });
  const window = dom.window as any;
  let networkCalls = 0, submits = 0;
  window.require = stub;
  window.exports = {};
  window.fetch = async () => { networkCalls++; throw new Error("Live login is forbidden in this test"); };
  window.eval(compiled);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const root = require("react-dom/client").createRoot(window.document.getElementById("root"));
  try {
    await React.act(async () => root.render(React.createElement(window.exports.LoginView, { liveEnabled: true, backendConfigured: true, apiBaseUrl: "https://api.test.invalid" })));
    const input = window.document.querySelector('input[autocomplete="current-password"]');
    const toggle = window.document.querySelector(".mm-admin__password-toggle");
    window.document.querySelector("form").addEventListener("submit", () => submits++);
    // Browser/password-manager autofill can change the DOM without input/change.
    input.value = "TEST-only-preview-not-a-real-password";
    await React.act(async () => toggle.click());
    assert.equal(input.type, "text");
    assert.equal(input.value, "TEST-only-preview-not-a-real-password");
    assert.equal(toggle.getAttribute("aria-label"), "Hide password");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    input.value = "TEST-only-updated-autofill";
    await React.act(async () => toggle.click());
    assert.equal(input.type, "password");
    assert.equal(input.value, "TEST-only-updated-autofill");
    assert.equal(toggle.getAttribute("aria-label"), "Show password");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(window.document.querySelector('input[autocomplete="current-password"]'), input);
    assert.equal(networkCalls, 0);
    assert.equal(submits, 0);
  } finally {
    await React.act(async () => root.unmount());
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    dom.window.close();
  }
});

test("the eye control has a mobile-sized tap target, reserved input space and visible keyboard focus", () => {
  assert.match(source, /\.mm-admin__password-toggle \{[^}]*width: 44px; height: 44px;/);
  assert.match(source, /\.mm-admin__password-field input \{ padding-right: 60px; \}/);
  assert.match(source, /\.mm-admin__password-toggle:focus-visible \{ outline: 2px solid var\(--mm-sage\)/);
});
