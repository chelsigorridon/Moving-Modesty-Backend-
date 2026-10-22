/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated renderer fixtures; no sessions or live requests. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { JSDOM, VirtualConsole } from "jsdom";

const require = createRequire(import.meta.url);
// Optional isolated React 18.3.1 install verifies Framer's renderer as well as Next's React.
const rendererRoot = process.env.MM_HYDRATION_REACT_ROOT;
const renderer = (name: string) => require(rendererRoot ? resolve(rendererRoot, "node_modules", name) : name);
const React = renderer("react"), { renderToString } = renderer("react-dom/server");
const source = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("AdminPortal.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const styleExpressions: string[] = [], styleNodes: string[] = [];
function collect(node: ts.Node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(parsed) === "style") {
    const expression = node.children.find(ts.isJsxExpression) as ts.JsxExpression;
    styleExpressions.push(expression.expression!.getText(parsed)); styleNodes.push(node.getText(parsed));
  } else if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === "style") {
    const prop = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(parsed) === "dangerouslySetInnerHTML") as ts.JsxAttribute;
    const object = (prop.initializer as ts.JsxExpression).expression as ts.ObjectLiteralExpression;
    const value = object.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(parsed) === "__html") as ts.PropertyAssignment;
    styleExpressions.push(value.initializer.getText(parsed)); styleNodes.push(node.getText(parsed));
  }
  ts.forEachChild(node, collect);
}
collect(parsed);
const augmented = `${source}\nexports.testStyles = [${styleNodes.join(",")}];\nexports.testCss = [${styleExpressions.join(",")}];`;
const compiled = ts.transpileModule(augmented, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function load(win?: any) {
  const compiledModule = { exports: {} as any }, requests: string[] = [];
  const fakeFetch = async (url: string, init: RequestInit = {}) => {
    assert.equal(init.method || "GET", "GET", "Rendering must never submit mutations");
    assert.equal(new URL(url).hostname, "preview.example.invalid");
    requests.push(url);
    return Response.json({ orders: [], products: [], discounts: [] });
  };
  new Function("require", "module", "exports", "fetch", "window", compiled)((name: string) => {
    if (name === "framer") return { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false };
    assert.ok(["react", "react/jsx-runtime"].includes(name)); return renderer(name);
  }, compiledModule, compiledModule.exports, fakeFetch, win);
  return { ...compiledModule.exports, requests };
}
const virtualConsole = new VirtualConsole();
// jsdom does not support every modern container/media rule; hydration errors are captured separately.
virtualConsole.on("jsdomError", (error: Error) => { if (!error.message.includes("CSS")) throw error; });

test(`every portal stylesheet survives HTML parsing byte-for-byte (React ${React.version})`, () => {
  const portal = load();
  assert.equal(portal.testStyles.length, 11, "Cover every root, catalogue, discount and delivery stylesheet");
  assert.ok(styleNodes.every(node => node.includes("dangerouslySetInnerHTML")), "Keep Framer React 18 raw-text serialization even when the main test runner uses React 19");
  for (const [index, element] of portal.testStyles.entries()) {
    const dom = new JSDOM(renderToString(element), { virtualConsole });
    assert.equal(dom.window.document.querySelector("style")!.textContent, portal.testCss[index], `Stylesheet ${index} must not become HTML entities`);
    dom.window.close();
  }
});

for (const view of ["login", "dashboard", "orders", "products", "discounts"]) {
  test(`${view} hydrates without recovery or replacing the server section (React ${React.version})`, async () => {
    const props = { view, apiBaseUrl: "https://preview.example.invalid" };
    const server = load(), html = renderToString(React.createElement(server.default, props));
    const dom = new JSDOM(`<div id="root">${html}</div>`, { url: `https://preview.example.invalid/admin/${view}`, virtualConsole });
    const win = dom.window as any, originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value, configurable: true });
    }
    win.sessionStorage.setItem("moving_modesty_admin_token", "TEST-only-no-real-session");
    win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
    win.HTMLElement.prototype.scrollIntoView = function () {};
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const container = win.document.getElementById("root"), section = container.firstElementChild;
    const recoveries: Error[] = [], warnings: unknown[][] = [], originalError = console.error;
    const client = load(win); let root: any;
    console.error = (...args: unknown[]) => warnings.push(args);
    try {
      await React.act(async () => {
        root = renderer("react-dom/client").hydrateRoot(container, React.createElement(client.default, props), { onRecoverableError: (error: Error) => recoveries.push(error) });
      });
      assert.deepEqual(recoveries.map(error => error.message), []);
      assert.deepEqual(warnings, []);
      assert.equal(container.firstElementChild, section, "Keep SSR markup instead of bailing out to a fresh client render");
      if (view === "login") {
        const password = container.querySelector('input[type="password"]');
        assert.ok(password); const button = container.querySelector('button[aria-label="Show password"]');
        assert.ok(button); await React.act(async () => button.click());
        assert.equal(password.type, "text");
      } else {
        assert.ok(client.requests.length > 0, "Effects still load the disconnected fixture after hydration");
        await React.act(async () => container.querySelector(".mm-admin__account summary").click());
      }
    } finally {
      if (root) await React.act(async () => root.unmount());
      console.error = originalError; dom.window.close();
      for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
}

test("style output uses only static repository CSS, never suppression, effect injection or customer data", () => {
  assert.doesNotMatch(source, /suppressHydrationWarning/);
  for (const expression of styleExpressions) assert.match(expression, /^(?:[a-zA-Z]+(?: \+ [a-zA-Z]+)?|`[^$]*`)$/);
  assert.doesNotMatch(source, /document\.(?:head|createElement)|\.insertRule\(/);
  for (const css of load().testCss) assert.doesNotMatch(css, /<\/style/i, "Trusted CSS must not terminate the raw-text element");
});
