/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated client-component test harness. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import * as catalogueInput from "../lib/catalogue-input.ts";
import * as catalogueEditor from "../lib/catalogue-editor.ts";

const require = createRequire(import.meta.url);

test("the demo has three guided steps, friendly validation and quick existing-product edits without network writes", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/product-trial" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], writable: true, configurable: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let confirmations = 0;
  dom.window.confirm = () => { confirmations++; return true; };
  let networkCalls = 0;
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(readFileSync(new URL("../components/product-catalogue-editor.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(compiled, { exports, crypto: globalThis.crypto, structuredClone, AbortController, AbortSignal, URL, window: dom.window,
    fetch: () => { networkCalls++; throw new Error("The demo must not call any backend"); },
    require: (name: string) => name === "@/lib/admin-client" ? { adminRequest: () => { networkCalls++; throw new Error("The demo must not call any backend"); } } : name === "@/lib/catalogue-input" ? catalogueInput : name === "@/lib/catalogue-editor" ? catalogueEditor : require(name),
  });
  const { createRoot } = require("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const doc = dom.window.document;
  function input(id: string, value: string) {
    const element = doc.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
    assert.ok(element, `Missing field ${id}`);
    const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  function button(text: string) {
    const element = [...doc.querySelectorAll("button")].find(element => element.textContent === text);
    assert.ok(element, `Missing button ${text}`);
    element.click();
  }
  function text() { return doc.body.textContent || ""; }
  try {
    await act(async () => root.render(React.createElement(exports.default, { demo: true })));
    await act(async () => button("Add product"));
    assert.deepEqual([...doc.querySelectorAll('[aria-label="Add product steps"] li')].map(element => element.textContent), ["1Product details", "2Colours & photos", "3Preview"]);
    assert.doesNotMatch(text(), /Page address|Display order|Publishing checklist|Publish —/);
    assert.equal(doc.querySelector('[aria-current="step"]')?.textContent, "1Product details");
    await act(async () => button("Continue"));
    assert.match(doc.getElementById("error-name")?.textContent || "", /Enter a product name/);
    assert.match(doc.getElementById("error-usualPrice")?.textContent || "", /Enter a price/);
    await act(async () => { input("product-name", "TEST Simple"); input("product-description", "Unpublished demo product"); input("product-usualPrice", "420"); input("product-colours-0-variants-0-size", "Small"); });
    await act(async () => button("Add size"));
    await act(async () => input("product-colours-0-variants-1-size", "small"));
    await act(async () => button("Continue"));
    assert.equal(doc.querySelectorAll('.mm-products__sizes input').length, 2, "duplicate size fields must remain editable");
    assert.match(doc.getElementById("error-colours-0-variants-1-size")?.textContent || "", /different name/);
    await act(async () => input("product-colours-0-variants-1-size", "Large"));
    await act(async () => button("Continue"));
    assert.equal(doc.querySelector('[aria-current="step"]')?.textContent, "2Colours & photos");
    await act(async () => input("product-colours-0-name", "Black"));
    await act(async () => button("Add colour"));
    await act(async () => input("product-colours-1-name", "Lavender"));
    assert.equal((doc.getElementById("product-colours-1-variants-0-price") as HTMLInputElement).value, "420");
    assert.equal((doc.getElementById("product-colours-1-variants-1-price") as HTMLInputElement).value, "420");
    await act(async () => { input("product-colours-0-variants-0-stock", "5"); input("product-colours-0-variants-1-price", "475"); input("product-colours-1-variants-0-stock", "-1"); });
    await act(async () => button("Continue"));
    assert.match(doc.getElementById("error-colours-1-variants-0-stock")?.textContent || "", /whole stock quantity/);
    await act(async () => input("product-colours-1-variants-0-stock", "3"));
    await act(async () => button("Back"));
    await act(async () => input("product-usualPrice", "450"));
    await act(async () => button("Continue"));
    assert.equal((doc.getElementById("product-colours-0-variants-0-price") as HTMLInputElement).value, "450");
    assert.equal((doc.getElementById("product-colours-0-variants-1-price") as HTMLInputElement).value, "475", "custom price must be retained");
    await act(async () => button("Continue"));
    assert.equal(doc.querySelector('[aria-current="step"]')?.textContent, "3Preview");
    const homepage = doc.querySelector('.mm-products__homepage input[type="checkbox"]') as HTMLInputElement;
    assert.equal(homepage.checked, true);
    await act(async () => homepage.click());
    assert.match(text(), /won’t appear in Our Collection/);
    await act(async () => button("Save demo product"));
    assert.match(doc.querySelector('[role="status"]')?.textContent || "", /Refreshing will reset/);
    assert.match(doc.querySelector('.mm-products__badge')?.textContent || "", /Available.*demo/);
    await act(async () => button("Edit product"));
    const sections = [...doc.querySelectorAll('.mm-products__accordion')];
    assert.equal(sections.length, 3);
    assert.ok(sections.every(section => !section.hasAttribute("open")));
    assert.equal(doc.querySelector('[aria-label="Add product steps"]'), null);
    await act(async () => input("product-colours-0-variants-0-stock", "8"));
    await act(async () => button("Save demo changes"));
    await act(async () => button("Edit product"));
    assert.equal((doc.getElementById("product-colours-0-variants-0-stock") as HTMLInputElement).value, "8");
    assert.equal(confirmations, 0, "routine steps must not show confirmation pop-ups");
    assert.equal(networkCalls, 0);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});

test("connected TEST editor keeps failed edits and accepts success only after CMS verification", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://127.0.0.1:3012/product-trial" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], writable: true, configurable: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const document = JSON.parse(readFileSync(new URL("../fixtures/catalogue-test-product.json", import.meta.url), "utf8"));
  let draft = { id: "Pd8cq0BT9", revision: 0, cmsVersion: "a".repeat(64), document };
  let outcome = "fail"; const requests: any[] = [];
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(readFileSync(new URL("../components/product-catalogue-editor.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const trialFetch = async (url: string, options: any) => {
      assert.equal(url, "/api/product-trial/framer"); assert.equal(options.headers.Authorization, undefined);
      if (!options.method) return Response.json({ products: [draft] });
      const body = JSON.parse(options.body); requests.push(body);
      if (outcome === "fail") return Response.json({ error: "TEST save could not be confirmed" }, { status: 503 });
      if (outcome === "unverified") return Response.json({ product: draft, published: false });
      draft = { ...draft, document: body.document, cmsVersion: "b".repeat(64), revision: 1 };
      return Response.json({ product: draft, cmsSynced: true, published: false });
    };
  runInNewContext(compiled, { exports, crypto: globalThis.crypto, structuredClone, AbortController, AbortSignal, URL, window: dom.window,
    fetch: trialFetch, require: (name: string) => name === "@/lib/admin-client" ? { adminRequest: trialFetch } : name === "@/lib/catalogue-input" ? catalogueInput : name === "@/lib/catalogue-editor" ? catalogueEditor : require(name),
  });
  const { createRoot } = require("react-dom/client"); const root = createRoot(dom.window.document.getElementById("root")!); const doc = dom.window.document;
  function button(text: string) { const element = [...doc.querySelectorAll("button")].find(element => element.textContent === text); assert.ok(element); element.click(); }
  try {
    await act(async () => root.render(React.createElement(exports.default, { framerTrial: true })));
    assert.equal([...doc.querySelectorAll("button")].some(button => button.textContent === "Add product"), false);
    await act(async () => button("Edit product"));
    assert.equal(doc.querySelectorAll("input,textarea").length, 3);
    await act(async () => { const element = doc.getElementById("product-description")!; Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, "TEST editor save verification"); element.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await act(async () => button("Save draft"));
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /could not be confirmed/);
    assert.equal((doc.getElementById("product-description") as HTMLTextAreaElement).value, "TEST editor save verification");
    assert.equal(doc.querySelector('[role="status"]'), null);
    outcome = "unverified"; await act(async () => button("Save draft"));
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /not confirmed/);
    assert.equal(doc.querySelector('[role="status"]'), null);
    outcome = "success"; await act(async () => button("Save draft"));
    assert.match(doc.querySelector('[role="status"]')?.textContent || "", /saved and verified in Framer/);
    assert.equal(requests[0].expectedCmsVersion, "a".repeat(64));
    assert.equal(requests[0].id, "Pd8cq0BT9");
    await act(async () => button("Edit product"));
    assert.equal((doc.getElementById("product-description") as HTMLTextAreaElement).value, "TEST editor save verification");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
