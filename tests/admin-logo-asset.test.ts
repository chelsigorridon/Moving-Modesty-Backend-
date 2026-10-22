import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);
const record = JSON.parse(readFileSync(new URL("framer/design/admin-navigation-logo.json", root), "utf8"));
const svg = readFileSync(new URL(record.asset.localPath, root), "utf8").replace(/\r\n/g, "\n");

test("the saved admin logo matches the published asset record and is self-contained SVG", () => {
  assert.equal(createHash("sha256").update(svg).digest("hex"), record.asset.sha256Lf);
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  try {
    const document = dom.window.document;
    assert.equal(document.documentElement.localName, "svg");
    assert.equal(document.documentElement.getAttribute("viewBox"), record.asset.viewBox);
    assert.equal(document.querySelectorAll("path").length, 1);
    assert.equal(document.querySelector("path")?.getAttribute("fill"), record.asset.colour);
    assert.equal(document.querySelector("script, foreignObject, image, use, style, a, animate"), null);
    for (const element of document.querySelectorAll("*")) {
      assert.ok([...element.attributes].every(attribute => !/^on|href$/i.test(attribute.name)));
    }
  } finally { dom.window.close(); }
});

test("the monogram reuses the existing logo outlines without the duplicate wordmark", () => {
  const source = readFileSync(new URL(record.asset.derivedFrom, root), "utf8");
  const originalPath = source.match(/<path d="([^"]+)"/)?.[1];
  assert.ok(originalPath);
  const end = originalPath.indexOf("M 242.226");
  assert.ok(end > 0);
  assert.equal(svg.match(/ d="([^"]+)"/)?.[1], originalPath.slice(0, end).trimEnd());
});

test("the native canvas record preserves responsive header sizing and does not configure backend services", () => {
  assert.equal(record.kind, "framer-canvas-change-record");
  assert.equal(record.publishedVersion, "2b7025c4d");
  assert.equal(record.brandFrame.children[0].width, "28px");
  assert.equal(record.brandFrame.children[0].height, "35px");
  assert.equal(record.mobileVariant.height, "72px");
  assert.deepEqual(record.verification.reviewedWidthsPx, [240, 320, 390]);
  assert.equal(record.verification.backendChanges, false);
  assert.equal(record.verification.syncSettingsChanges, false);
  assert.equal(record.verification.existingNavigationLinksUnchanged, true);
});
