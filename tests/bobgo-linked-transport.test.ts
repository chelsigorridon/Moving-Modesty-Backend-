/* eslint-disable @typescript-eslint/no-explicit-any -- Offline transport/runtime doubles. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectionBookId, linkedOrderMatch } from "../lib/integrations/bobgo/linked-booking-policy.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
function load(file: string, stubs: Record<string, any> = {}): any {
  const path = resolve(root, file), loadedModule = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", "fetch", "process", compiled)((name: string) => {
    if (name === "server-only") return {};
    if (Object.hasOwn(stubs, name)) return stubs[name];
    if (name.startsWith(".")) return load(resolve(dirname(path), name) + (name.endsWith(".ts") ? "" : ".ts"), stubs);
    return require(name);
  }, loadedModule, loadedModule.exports, () => { throw new Error("Live network forbidden"); }, { env: {} });
  return loadedModule.exports;
}

test("linked transport targets the order fulfilment API with channel authentication and no POST retries", async () => {
  const { createLinkedBookingTransport } = load("lib/integrations/bobgo/linked-booking-transport.ts");
  const calls: any[] = []; let fail = false;
  const transport = createLinkedBookingTransport({ enabled: true, environment: "sandbox", channelRef: "store.example.invalid" }, "TEST-ONLY-TOKEN", async (url: string, options: any) => {
    calls.push({ url, options });
    if (fail) return new Response("PRIVATE API KEY AND ADDRESS", { status: 503 });
    return Response.json(url.includes("/orders?") ? { orders: [{ id: 77 }] } : {});
  });
  await transport.readPermissions(); await transport.readCollections(); await transport.readOrder("77");
  await transport.updateOrder({ id: 77 }); await transport.orderRates({ order_id: 77 }); await transport.createFulfillment({ order_id: 77 });
  assert.deepEqual(calls.map(call => call.options.method), ["GET", "GET", "GET", "PATCH", "POST", "POST"]);
  assert.equal(calls.at(-1).url, "https://api.sandbox.bobgo.co.za/v2/order-fulfillments");
  for (const call of calls) { assert.equal(call.options.redirect, "error"); assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.headers.Authorization, "Bearer TEST-ONLY-TOKEN"); assert.equal(call.options.headers["bobgo-channel-identifier"], "store.example.invalid"); }
  const before = calls.length; fail = true;
  await assert.rejects(transport.createFulfillment({ order_id: 77 }), (error: any) => error.status === 503 && !/PRIVATE|KEY|ADDRESS/.test(error.message));
  assert.equal(calls.length, before + 1);
  fail = false; await transport.cancelFulfillment("123");
  assert.equal(calls.at(-1).url, "https://api.sandbox.bobgo.co.za/v2/order-fulfillments/cancel");
  assert.equal(calls.at(-1).options.method, "POST"); assert.deepEqual(JSON.parse(calls.at(-1).options.body), { id: 123 });
  const cancelledCalls = calls.length; fail = true;
  await assert.rejects(transport.cancelFulfillment("123")); assert.equal(calls.length, cancelledCalls + 1, "uncertain cancellation is never retried by transport");
  const count = calls.length; await assert.rejects(transport.readOrder("../wrong")); assert.equal(calls.length, count);
  assert.throws(() => createLinkedBookingTransport({ enabled: false, environment: "sandbox", channelRef: "store.example.invalid" }, "TEST-ONLY-TOKEN"));
});

test("runtime remains hard off before credentials, database or provider access", () => {
  const forbidden = () => { throw new Error("Must not touch live services"); };
  const runtime = load("lib/integrations/bobgo/linked-booking-runtime.ts", {
    "../../db": { requireDatabase: forbidden }, "./linked-booking": { createLinkedBookingService: forbidden },
    "./linked-booking-transport": { createLinkedBookingTransport: forbidden },
    "./order-sync-runtime": { preparedSyncCredentials: (config: any) => { assert.equal(config.enabled, false); return null; } },
  });
  assert.throws(() => runtime.configuredLinkedBooking(), /not activated/);
  assert.throws(() => runtime.configuredLinkedWaybillChanges(), /not activated/);
});

test("collection matching supports the real address-book fields and never substitutes a different drop-off", () => {
  const collection: any = { kind: "pickup_point", point: { id: "90", providerSlug: "demo" }, contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" }, address: {} };
  const item = { id: 21, is_collection_address: true, contact_name: "TEST", contact_surname: "Sender", email: "sender@example.invalid", mobile_number: "0821234567",
    pickup_point_location_id: 90, pickup_point_provider_slug: "demo", pickup_point_location: { id: 90, provider_slug: "demo", active: true }, address: null };
  assert.equal(collectionBookId({ items: [item], count: 1 }, collection), "21");
  for (const value of [{ ...item, mobile_number: "0827654321" }, { ...item, email: "other@example.invalid" }, { ...item, is_collection_address: false },
    { ...item, pickup_point_location: { ...item.pickup_point_location, id: 91 } }, { ...item, pickup_point_active: false }]) {
    assert.throws(() => collectionBookId({ items: [value], count: 1 }, collection));
  }
  assert.throws(() => collectionBookId({ items: [item, item], count: 2 }, collection));
  assert.throws(() => collectionBookId({ items: [item], count: 2 }, collection));
  assert.equal(linkedOrderMatch({}, {} as any), null);
});

test("the permission diagnostic is GET-only and imports neither app/DB code nor a sync worker", () => {
  const source = readFileSync(resolve(root, "scripts/check-bobgo-linked-permissions.mjs"), "utf8");
  assert.doesNotMatch(source, /method: "(?:POST|PATCH|DELETE)"|requireDatabase|createOrder|createFulfillment|runConfiguredBobGoSync/);
  assert.match(source, /method: "GET"/);
});
