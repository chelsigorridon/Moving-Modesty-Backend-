/* eslint-disable @typescript-eslint/no-explicit-any -- Offline Framer renderer fixture; no real forms, stock, orders or requests. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { JSDOM, VirtualConsole } from "jsdom";

const require = createRequire(import.meta.url), rendererRoot = process.env.MM_HYDRATION_REACT_ROOT;
const renderer = (name: string) => require(rendererRoot ? resolve(rendererRoot, "node_modules", name) : name);
const React = renderer("react"), { renderToString } = renderer("react-dom/server");
const expectOldFailure = process.env.MM_EXPECT_STOREFRONT_MISMATCH === "true";
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error: Error) => { if (!error.message.includes("CSS")) throw error; });
const fixtures = [
  { name: "ContactForm", selector: ".mm-contact-form", props: { accentColor: "rgb(83, 96, 71)", borderColor: "rgb(182, 174, 167)" } },
  { name: "CMSProductCarousel", selector: ".mm-product-carousel", props: { carouselImages: [{ image: { src: "https://images.example.invalid/one.jpg", alt: "Sample one" } }, { image: { src: "https://images.example.invalid/two.jpg", alt: "Sample two" } }], autoPlay: false } },
];

function load(name: string, win?: any) {
  const source = readFileSync(new URL(`../framer/${name}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} as any }, motionTags = new Map<string, any>();
  const motion = new Proxy({}, { get(_target, tag: string) {
    if (!motionTags.has(tag)) motionTags.set(tag, React.forwardRef(function FixtureMotion(props: any, ref: any) {
      const attributes = { ...props, ref }; for (const key of ["initial", "animate", "exit", "transition"]) delete attributes[key];
      return React.createElement(tag, attributes);
    })); return motionTags.get(tag);
  } });
  new Function("require", "module", "exports", "fetch", "window", compiled)((dependency: string) => {
    if (dependency === "framer") return { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false };
    if (dependency === "framer-motion") return { motion, AnimatePresence: ({ children }: any) => children };
    assert.ok(["react", "react/jsx-runtime"].includes(dependency)); return renderer(dependency);
  }, mod, mod.exports, () => assert.fail("Rendering must never send a request"), win);
  return { Component: mod.exports.default, source };
}

for (const fixture of fixtures) {
  test(`${fixture.name} preserves CSS through server HTML parsing (React ${React.version})`, () => {
    const { Component, source } = load(fixture.name);
    const html = renderToString(React.createElement(Component, fixture.props));
    const dom = new JSDOM(html, { virtualConsole });
    const css = dom.window.document.querySelector("style")!.textContent!;
    try {
      if (expectOldFailure) { assert.match(css, /&quot;/); return; }
      assert.doesNotMatch(css, /&(?:quot|amp|lt|gt|#x27);/);
      assert.match(source, /dangerouslySetInnerHTML/);
      assert.doesNotMatch(source, /suppressHydrationWarning|document\.(?:head|createElement)|\.insertRule\(/);
      assert.match(css, fixture.name === "ContactForm" ? /button\[type="submit"\]/ : /content: ""/);
    } finally { dom.window.close(); }
  });

  test(`${fixture.name} hydrates in place without warnings and keeps its controls (React ${React.version})`, async () => {
    const server = load(fixture.name), html = renderToString(React.createElement(server.Component, fixture.props));
    const dom = new JSDOM(`<div id="root">${html}</div>`, { url: "https://local-review.example.invalid/", virtualConsole });
    const win = dom.window as any, originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true });
    }
    const client = load(fixture.name, win), container = win.document.getElementById("root"), original = container.querySelector(fixture.selector);
    const css = original.querySelector("style").textContent;
    const recoveries: Error[] = [], warnings: unknown[][] = [], originalError = console.error; let root: any;
    console.error = (...args: unknown[]) => warnings.push(args);
    try {
      await React.act(async () => { root = renderer("react-dom/client").hydrateRoot(container, React.createElement(client.Component, fixture.props), { onRecoverableError: (error: Error) => recoveries.push(error) }); });
      if (expectOldFailure) { assert.ok(recoveries.length > 0); assert.notEqual(container.querySelector(fixture.selector), original); return; }
      assert.deepEqual(recoveries.map(error => error.message), []); assert.deepEqual(warnings, []);
      assert.equal(container.querySelector(fixture.selector), original); assert.equal(original.querySelector("style").textContent, css);
      if (fixture.name === "ContactForm") {
        assert.equal(original.querySelectorAll("input").length, 3); assert.ok(original.querySelector("textarea"));
        assert.equal(original.querySelector('button[type="submit"]').textContent, "SEND MESSAGE");
      } else {
        const next = original.querySelector('button[aria-label="Next product image"]'); assert.ok(next);
        await React.act(async () => next.click());
        assert.match(original.querySelector("img").src, /two\.jpg$/);
        assert.ok(original.querySelector('button[aria-label="Previous product image"]'));
      }
    } finally {
      if (root) await React.act(async () => root.unmount()); console.error = originalError; dom.window.close();
      for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
}

test("raw CSS cannot terminate its stylesheet through a colour property", () => {
  if (expectOldFailure) return;
  for (const fixture of fixtures) {
    const { Component } = load(fixture.name);
    const attack = '</style><script>throw new Error("unsafe")</script><style>';
    const dom = new JSDOM(renderToString(React.createElement(Component, { ...fixture.props, accentColor: attack, arrowColour: attack, dotColour: attack })), { virtualConsole });
    assert.equal(dom.window.document.querySelectorAll("script").length, 0); assert.equal(dom.window.document.querySelectorAll("style").length, 1); dom.window.close();
  }
});
