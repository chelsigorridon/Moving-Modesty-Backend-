/* eslint-disable @typescript-eslint/no-explicit-any -- Executes the Framer component in an isolated DOM harness. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToString } = require("react-dom/server");
const source = readFileSync(new URL("../framer/DeliveryWelcome.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

async function harness(options: { scrolled?: boolean; static?: boolean; blockedStorage?: boolean; path?: string; url?: string; reducedMotion?: boolean; props?: any } = {}) {
  const dom = new JSDOM('<button id="hero-cta">Shop the collection</button><div id="root"></div>', {
    url: options.url ?? `https://holistic-brand-492217.framer.app${options.path ?? "/"}`, runScripts: "outside-only",
  });
  const window = dom.window as any;
  Object.defineProperty(window, "scrollY", { value: options.scrolled ? 1000 : 0, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  window.setTimeout = (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = (id: number) => timers.delete(id);
  if (options.blockedStorage) Object.defineProperty(window, "sessionStorage", { get() { throw new Error("Storage blocked"); } });
  window.require = (name: string) => {
    if (name === "framer") return { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => options.static ?? false };
    if (name === "framer-motion") return {
      useReducedMotion: () => options.reducedMotion ?? false,
      motion: { div: ({ initial, animate, transition, ...props }: any) => {
        void initial; void animate; void transition;
        return React.createElement("div", props);
      } },
    };
    return require(name);
  };
  window.exports = {};
  window.eval(compiled);
  const Component = window.exports.default;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const root = createRoot(window.document.getElementById("root"));
  const render = async (props: any = {}) => React.act(async () => root.render(React.createElement(Component, props)));
  window.document.body.style.overflow = "auto";
  window.document.getElementById("hero-cta").focus();
  await render(options.props);
  return {
    dom, window, timers, Component, render,
    notice: () => window.document.querySelector("dialog[open]"),
    async scrollTo(y: number) { await React.act(async () => {
      Object.defineProperty(window, "scrollY", { value: y, configurable: true });
      window.dispatchEvent(new window.Event("scroll"));
    }); },
    async expire() { await React.act(async () => {
      const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.callback());
    }); },
    async click(selector: string) { await React.act(async () => window.document.querySelector(selector).click()); },
    async close() {
      await React.act(async () => root.unmount());
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    },
  };
}

test("delivery popup waits ten seconds AND until the visitor scrolls past the hero", async () => {
  const page = await harness();
  try {
    assert.equal([...page.timers.values()][0].delay, 10_000);
    assert.equal(page.notice(), null);
    await page.expire();
    assert.equal(page.notice(), null);
    await page.scrollTo(1000);
    assert.ok(page.notice());
    assert.equal(page.window.document.body.style.overflow, "hidden");
    const root = page.window.document.querySelector("[data-mm-delivery-popup]");
    assert.equal(root.style.height, "0px");
    assert.equal(page.notice().parentElement, root);
    assert.equal(page.window.document.querySelector("aside a").getAttribute("href"), "/#collection");
  } finally { await page.close(); }
});

test("scrolling early cannot bypass the delay, and returning to the hero prevents interruption there", async () => {
  const page = await harness({ scrolled: true });
  try {
    assert.equal(page.notice(), null);
    await page.scrollTo(0);
    await page.expire();
    assert.equal(page.notice(), null);
    await page.scrollTo(1000);
    assert.ok(page.notice());
  } finally { await page.close(); }
});

test("Close restores scrolling and the popup stays dismissed on a page revisit", async () => {
  const page = await harness({ scrolled: true });
  try {
    await page.expire();
    await page.click(".mm-delivery-popup-close");
    assert.equal(page.notice(), null);
    assert.equal(page.window.document.body.style.overflow, "auto");
    await page.render();
    assert.equal(page.notice(), null);
    // Remount a new component instance using the same visit storage/module state.
    await page.render({ key: "revisit" });
    assert.equal(page.notice(), null);
    assert.equal(page.timers.size, 0);
  } finally { await page.close(); }
});

test("blocked storage retains the in-memory once-per-visit fallback", async () => {
  const page = await harness({ scrolled: true, blockedStorage: true });
  try {
    await page.expire();
    assert.ok(page.notice());
    await page.click(".mm-delivery-popup-close");
    await page.render({ key: "revisit" });
    assert.equal(page.notice(), null);
  } finally { await page.close(); }
});

test("non-home pages never show the promotion, and unmount cancels its timer", async () => {
  for (const path of ["/checkout", "/cart", "/admin/orders", "/amina", "/hawa"]) {
    const page = await harness({ path, scrolled: true });
    try { assert.equal(page.notice(), null); assert.equal(page.timers.size, 0); }
    finally { await page.close(); }
  }
  const page = await harness();
  assert.equal(page.timers.size, 1);
  await page.close();
  assert.equal(page.timers.size, 0);
});

test("canvas stays initially hidden and offers an explicit editing preview without timers", async () => {
  const page = await harness({ static: true, reducedMotion: true });
  try {
    assert.equal(page.window.document.querySelectorAll("aside").length, 0);
    await page.render({ canvasPreview: true });
    assert.equal(page.window.document.querySelectorAll("aside").length, 1);
    assert.equal(page.timers.size, 0);
    assert.match(page.window.document.querySelector("aside style").textContent, /max-width: 767px/);
    assert.doesNotMatch(source, /querySelector|getBoundingClientRect/);
  } finally { await page.close(); }
});

test("Framer runtime preview respects the per-page enabled control", async () => {
  for (const enabled of [true, false]) {
    const page = await harness({ scrolled: true, props: { enabled },
      url: "https://project-hsoqpurwmbvb013b2lkg.framercanvas.com/s/app/preview-module.html" });
    try {
      await page.expire();
      assert.equal(Boolean(page.notice()), enabled);
      if (enabled) {
        await page.render({ enabled: false });
        assert.equal(page.notice(), null);
        assert.equal(page.window.document.body.style.overflow, "auto");
      }
    } finally { await page.close(); }
  }
});

test("server render is safe and reserves no inline promotional space", async () => {
  const page = await harness();
  const Component = page.Component;
  await page.close();
  const html = renderToString(React.createElement(Component));
  assert.match(html, /data-mm-delivery-popup="waiting"/);
  assert.match(html, /height:0/);
  assert.doesNotMatch(html, /<dialog[^>]*\sopen[\s=>]/);
});

test("Escape and backdrop clicks close the popup, and CTA keeps its collection destination", async () => {
  for (const action of ["escape", "backdrop", "cta"]) {
    const page = await harness({ scrolled: true });
    try {
      await page.expire();
      if (action === "escape") await React.act(async () => page.notice().dispatchEvent(new page.window.Event("cancel", { cancelable: true })));
      else if (action === "backdrop") await page.click("dialog");
      else {
        assert.equal(page.window.document.querySelector("aside a").getAttribute("href"), "/#collection");
        await page.click("aside a");
      }
      assert.equal(page.notice(), null);
      assert.equal(page.window.document.body.style.overflow, "auto");
    } finally { await page.close(); }
  }
});
