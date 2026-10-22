import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedText, readLimitedJson, RequestBodyError } from "../lib/request-body.ts";

const post = (body: string, headers: Record<string, string> = {}) => new Request("https://test.invalid", { method: "POST", body, headers });

test("body limits count UTF-8 bytes, not characters or a trusted Content-Length", async () => {
  assert.equal(await readLimitedText(post("hello"), 5), "hello");
  assert.equal(await readLimitedText(post("é"), 2), "é");
  for (const request of [post("123456"), post("123456", { "content-length": "1" }), post("ééé")]) {
    await assert.rejects(readLimitedText(request, 5), error => error instanceof RequestBodyError && error.status === 413);
  }
  await assert.rejects(readLimitedText(post("a", { "content-length": "999" }), 5), { status: 413 });
});

test("chunked bodies are cancelled at the limit and multi-byte decoding spans chunks", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } });
  const request = new Request("https://test.invalid", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readLimitedText(request, 10), { status: 413 });
  assert.equal(cancelled, true);
  const unicode = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xc3])); controller.enqueue(new Uint8Array([0xa9])); controller.close(); } });
  assert.equal(await readLimitedText(new Request("https://test.invalid", { method: "POST", body: unicode, duplex: "half" } as RequestInit), 2), "é");
});

test("JSON parsing accepts the exact media type and safely rejects malformed input", async () => {
  assert.deepEqual(await readLimitedJson(post('{"ok":true}', { "content-type": "Application/JSON; charset=utf-8" }), 100), { ok: true });
  await assert.rejects(readLimitedJson(post("{}"), 100), { status: 415 });
  await assert.rejects(readLimitedJson(post("{}", { "content-type": "application/json-evil" }), 100), { status: 415 });
  await assert.rejects(readLimitedJson(post("{", { "content-type": "application/json" }), 100), { status: 400 });
});
