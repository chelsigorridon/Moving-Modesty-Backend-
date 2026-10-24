/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated browser/client adapter; no live network. */
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

test("live stock editor accepts only confirmed backend availability and restores the original switch", async () => {
  const require = createRequire(import.meta.url);
  const dom = new JSDOM("<div id='root'></div>", { url: "https://admin.test.invalid/products" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const originalGlobals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[name], writable: true, configurable: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.confirm = () => true;
  const baseline = catalogueInput.catalogueDocumentSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/catalogue-test-product.json", import.meta.url), "utf8")));
  baseline.colours = [baseline.colours[0]];
  baseline.colours[0].available = true;
  baseline.colours[0].variants = ["Small", "Large"].map(size => ({ id: crypto.randomUUID(), size, price: 420, stock: 3, stockVerified: true, available: true }));
  let saved: any = { id: crypto.randomUUID(), document: structuredClone(baseline), revision: 1, publishedRevision: 1, publicationState: "idle", stockVersion: "a".repeat(64) };
  let confirmed = false, publishCalls = 0, saveCalls = 0;
  const request = async (url: string, options: any = {}) => {
    assert.ok(["/api/admin/product-catalogue", "https://review.test.invalid/api/admin/product-catalogue"].includes(url));
    if (!options.method) return Response.json({ products: [saved] });
    const body = JSON.parse(options.body);
    if (body.action === "publish") {
      publishCalls++;
      if (confirmed) saved = { ...saved, publishedRevision: saved.revision };
      return Response.json({ product: saved, published: true, cmsSynced: false, stockSynced: confirmed, publicationTarget: "inventory" });
    }
    saveCalls++;
    if (saved.stockReviewRequired) assert.equal(body.stockReviewConfirmed, true, "The explicit review must reach the backend");
    saved = { ...saved, document: body.document, revision: saved.revision + 1, stockReviewRequired: false, stockRecoveryNotice: undefined, stockConflicts: [] };
    return Response.json({ product: saved, published: false });
  };
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(readFileSync(new URL("../components/product-catalogue-editor.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { exports, crypto: globalThis.crypto, structuredClone, AbortController, AbortSignal, URL, window: dom.window,
    fetch: () => { throw new Error("No direct fetch allowed in this isolated test"); }, require: (name: string) => name === "@/lib/admin-client" ? { adminRequest: request } : name === "@/lib/catalogue-input" ? catalogueInput : name === "@/lib/catalogue-editor" ? catalogueEditor : require(name) });
  const { createRoot } = require("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const doc = dom.window.document;
  function button(text: string) { const element = [...doc.querySelectorAll("button")].find(e => e.textContent === text); assert.ok(element, text); element.click(); }
  function small() { const label = [...doc.querySelectorAll("label")].find(e => e.textContent === "Small available"); assert.ok(label); return label.querySelector("input")!; }
  try {
    await act(async () => root.render(React.createElement(exports.default, { live: true })));
    await act(async () => button("Edit product"));
    await act(async () => small().click());
    assert.equal(small().checked, false);
    await act(async () => button("Publish"));
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /could not be verified/);
    assert.equal(doc.querySelector('[role="status"]'), null, "An unverified stock response is never a success");
    assert.equal(small().checked, false, "The draft remains in the editor after a failed response");
    confirmed = true;
    await act(async () => button("Publish"));
    assert.match(doc.querySelector('[role="status"]')?.textContent || "", /stock and availability updated/);
    assert.doesNotMatch(doc.querySelector('[role="status"]')?.textContent || "", /page, collection card/);
    await act(async () => button("Edit product"));
    assert.equal(small().checked, false);
    await act(async () => small().click());
    await act(async () => button("Publish"));
    assert.deepEqual(saved.document, baseline);
    assert.equal(publishCalls, 3);
    saved = { ...saved, document: structuredClone(saved.document), stockReviewRequired: true,
      stockRecoveryNotice: "Stock changed since this draft was saved. Check the quantities below before saving.",
      stockConflicts: [{ id: saved.document.colours[0].variants[0].id, colour: saved.document.colours[0].name, size: "Small", currentStock: 2, draftStock: 3, currentStockVerified: true, draftStockVerified: true }] };
    saved.document.colours[0].variants[0].stock = 2;
    await act(async () => root.render(React.createElement(exports.default, { live: true, apiBaseUrl: "https://review.test.invalid" })));
    await act(async () => button("Edit product"));
    assert.match(doc.querySelector('[aria-label="Stock update review"]')?.textContent || "", /current stock 2; saved draft 3/);
    const review = () => [...doc.querySelectorAll("label")].find(e => e.textContent?.includes("checked these quantities against my physical stock"))?.querySelector("input");
    assert.ok(review()); assert.equal(review()!.checked, false);
    const savesBeforeReview = saveCalls;
    await act(async () => button("Save draft"));
    assert.equal(saveCalls, savesBeforeReview, "Unconfirmed recovery cannot send a save request");
    assert.match(doc.querySelector('[role="alert"]')?.textContent || "", /stock confirmation/);
    await act(async () => review()!.click());
    await act(async () => small().click());
    assert.equal(review()!.checked, false, "Editing after a review invalidates the confirmation");
    await act(async () => review()!.click());
    await act(async () => button("Save draft"));
    assert.equal(saveCalls, savesBeforeReview + 1);
    assert.equal(publishCalls, 3, "Saving a reviewed draft does not publish anything");
    await act(async () => button("Edit product"));
    assert.equal(doc.querySelector('[aria-label="Stock update review"]'), null);
    // The bulk switch now describes its actual checked action: ticking means
    // sold out for this colour, never a positive "available" setting.
    const allSoldOut = () => doc.querySelector<HTMLInputElement>(`input[aria-label="Mark all sizes in ${baseline.colours[0].name} as sold out"]`)!;
    assert.ok(allSoldOut());
    assert.equal(allSoldOut().closest("label")?.textContent, "Mark all as sold out");
    assert.equal(allSoldOut().checked, false);
    const sizeChoices = [...saved.document.colours[0].variants].map((variant: any) => variant.available);
    const counts = saved.document.colours[0].variants.map((variant: any) => [variant.stock, variant.stockVerified]);
    const publishedBeforeBulk = publishCalls;
    await act(async () => allSoldOut().click());
    assert.equal(allSoldOut().checked, true);
    assert.equal(publishCalls, publishedBeforeBulk, "Toggling does not publish a live change");
    await act(async () => button("Save draft"));
    assert.equal(saved.document.colours[0].available, false, "Checked bulk switch pauses every size through the colour gate");
    assert.deepEqual(saved.document.colours[0].variants.map((variant: any) => variant.available), sizeChoices, "Size-specific choices are retained");
    assert.deepEqual(saved.document.colours[0].variants.map((variant: any) => [variant.stock, variant.stockVerified]), counts, "The bulk switch never rewrites quantities");
    assert.equal(publishCalls, publishedBeforeBulk, "Saving is still draft-only");
    await act(async () => button("Edit product"));
    assert.equal(allSoldOut().checked, true, "A saved sold-out colour reopens as checked");
    await act(async () => allSoldOut().click());
    assert.equal(allSoldOut().checked, false);
    await act(async () => button("Save draft"));
    assert.equal(saved.document.colours[0].available, true);
    assert.deepEqual(saved.document.colours[0].variants.map((variant: any) => variant.available), sizeChoices, "Restoring the colour preserves an already unavailable individual size");
    saved.document.colours[0].variants = [{ ...saved.document.colours[0].variants[0], size: "One size fits all", available: false }];
    await act(async () => root.render(React.createElement(exports.default, { live: true })));
    await act(async () => button("Edit product"));
    assert.equal(allSoldOut().checked, true, "An unavailable one-size colour starts checked");
    await act(async () => allSoldOut().click());
    await act(async () => button("Save draft"));
    assert.equal(saved.document.colours[0].available, true);
    assert.equal(saved.document.colours[0].variants[0].available, true, "Unticking restores the sole size too");
    await act(async () => button("Edit product"));
    await act(async () => allSoldOut().click());
    await act(async () => button("Save draft"));
    assert.equal(saved.document.colours[0].available, false);
    assert.equal(saved.document.colours[0].variants[0].available, false, "Ticking marks the sole size sold out");
    assert.equal(publishCalls, publishedBeforeBulk, "No switch or draft-only save can publish implicitly");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const name of names) { const descriptor = originalGlobals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
