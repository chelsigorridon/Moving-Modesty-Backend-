/* eslint-disable @typescript-eslint/no-explicit-any -- Offline transport/route doubles only. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseBobGoPackages } from "../lib/integrations/bobgo/packages.ts";

const require = createRequire(import.meta.url);
function load(file: string, stubs: Record<string, any> = {}, env: Record<string, string> = {}) {
  const exports: any = {};
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { exports, Buffer, URL, URLSearchParams, AbortSignal, Response, fetch: () => { throw new Error("Live network forbidden"); }, process: { env },
    require: (name: string) => name === "server-only" ? {} : Object.hasOwn(stubs, name) ? stubs[name] : require(name) });
  return exports;
}
test("saved Bob Go packages use dimensions only, never the volumetric figure as actual weight", () => {
  const rows = parseBobGoPackages({ packages: [{ name: "Flyer", length_cm: 40, width_cm: 32, height_cm: 6, volumetric_weight: 1.92 }, { name: "Invalid", length_cm: -1 }] });
  assert.equal(rows.length, 1); assert.equal(rows[0].lengthCm, 40);
  assert.equal("weightGrams" in rows[0], false); assert.equal("volumetric_weight" in rows[0], false);
  assert.throws(() => parseBobGoPackages({ error: "not a package list" }));
});

test("order transport reconciles active and archived copies, restricts destinations and fails closed on unknown responses", async () => {
  const { createBobGoSyncTransport } = load("../lib/integrations/bobgo/order-sync-transport.ts");
  const config = { enabled: true, environment: "sandbox", channelRef: "TEST-CHANNEL" }, calls: any[] = [];
  let mode = "normal";
  const fetcher = async (url: string, options: any) => {
    calls.push({ url, options }); const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.sandbox.bobgo.co.za"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer TEST-ONLY-TOKEN");
    assert.equal(options.headers["bobgo-channel-identifier"], config.channelRef, "the sales-channel identifier must accompany every key-authenticated request");
    if (mode === "failure") return new Response("PRIVATE ADDRESS SECRET API KEY", { status: 403 });
    if (mode === "unknown") return Response.json({ data: "unrecognised" });
    if (parsed.pathname.endsWith("/order-fulfillments")) return Response.json({ order_fulfillments: [] });
    if (parsed.pathname.endsWith("/shipments")) return Response.json({ shipments: [{ id: 88, tracking_reference: "TEST" }] });
    return Response.json({ orders: [{ id: 77, channel_order_number: mode === "wrong" ? "OTHER" : "MM-TEST-SYNC", channel_ref_id: "TEST-CHANNEL" }] });
  };
  const provider = createBobGoSyncTransport(config, "TEST-ONLY-TOKEN", fetcher);
  assert.equal((await provider.findOrders("MM-TEST-SYNC")).length, 1, "same active/archived ID is deduplicated");
  assert.equal(calls.length, 2); assert.match(calls[1].url, /archived=true/);
  assert.equal((await provider.readShipment("88")).id, 88);
  assert.equal((await provider.readOrderFulfillments("77")).order_fulfillments.length, 0);
  assert.match(calls.at(-1).url, /\/order-fulfillments\?order_id=77$/);
  const before = calls.length; await assert.rejects(provider.findOrders("../bad?token=private")); assert.equal(calls.length, before);
  await assert.rejects(provider.readOrderFulfillments("MM-TEST-SYNC")); assert.equal(calls.length, before);
  mode = "wrong"; await assert.rejects(provider.findOrders("MM-TEST-SYNC"));
  mode = "unknown"; await assert.rejects(provider.findOrders("MM-TEST-SYNC"));
  await assert.rejects(provider.readOrderFulfillments("77"));
  mode = "failure";
  await assert.rejects(provider.findOrders("MM-TEST-SYNC"), (error: any) => error.status === 403 && !/PRIVATE|SECRET|TOKEN/.test(error.message));
  assert.throws(() => createBobGoSyncTransport({ ...config, enabled: false }, "TEST-ONLY-TOKEN", fetcher));
  assert.throws(() => createBobGoSyncTransport(config, "bad\r\ntoken", fetcher));
  assert.throws(() => createBobGoSyncTransport({ ...config, channelRef: "store.example\r\nInjected: value" }, "TEST-ONLY-TOKEN", fetcher));
  assert.ok(calls.every(call => call.options.method === "GET"), "lookup never posts or books anything");
});

test("sales-channel authentication includes the identifier on order creation without changing the sync gate", async () => {
  const { createBobGoSyncTransport } = load("../lib/integrations/bobgo/order-sync-transport.ts");
  const calls: any[] = [];
  const provider = createBobGoSyncTransport({ enabled: true, environment: "production", channelRef: "store.example.invalid" }, "TEST-ONLY-TOKEN", async (url: string, options: any) => {
    calls.push({ url, options });
    return Response.json({ order: { id: 99 } });
  });
  const result = await provider.createOrder({ channel_order_number: "MM-TEST-HEADERS" });
  assert.equal(result.id, 99);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.bobgo.co.za/v2/orders");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer TEST-ONLY-TOKEN");
  assert.equal(calls[0].options.headers["bobgo-channel-identifier"], "store.example.invalid");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
});

test("prepared runtime stays disabled even with credentials; auth and domain/deployment checks fail closed", async () => {
  let touched = 0;
  const forbidden = () => { touched++; throw new Error("Must not touch live services"); };
  const policy = { getOrderSyncConfiguration: () => ({ enabled: false, environment: "sandbox", channelRef: "not-activated" }) };
  const env: Record<string, string> = { CRON_SECRET: "TEST-SECRET-".repeat(5), BOBGO_ORDER_SYNC_API_TOKEN: "TEST-ONLY-TOKEN", BOBGO_ORDER_SYNC_CHANNEL_REF: "store.example.invalid", STORE_URL: "https://store.example.invalid", VERCEL_ENV: "production" };
  const runtime = load("../lib/integrations/bobgo/order-sync-runtime.ts", {
    "../../db": { requireDatabase: forbidden }, "../../monitoring": { reportFailure: forbidden, resolveFailures: forbidden },
    "./configuration": { getBobGoConfiguration: () => ({ environment: "sandbox" }) }, "./order-sync-policy": policy,
    "./order-sync-transport": { createBobGoSyncTransport: forbidden }, "./order-sync-runner": { createBobGoSyncRunner: forbidden },
    "./order-sync": { createBobGoOrderSyncService: forbidden }, "../../db/schema": { orders: {} },
  }, env);
  assert.equal((await runtime.runConfiguredBobGoSync()).enabled, false);
  assert.equal((await runtime.retryConfiguredBobGoSync("MM-TEST")).status, "disabled"); assert.equal(touched, 0);
  assert.equal((await runtime.checkConfiguredBobGoWaybillLink("MM-TEST")).status, "disabled"); assert.equal(touched, 0);
  const good = new Request("https://example.invalid/api/internal/bobgo-sync", { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
  assert.equal(runtime.isSyncRunnerAuthorized(good), true); assert.equal(runtime.isSyncRunnerAuthorized(new Request(good.url)), false);
  assert.equal(runtime.isSyncRunnerAuthorized(good, "short"), false);
  const config = { enabled: true, environment: "sandbox", channelRef: "store.example.invalid" };
  assert.ok(runtime.preparedSyncCredentials(config));
  env.STORE_URL = "https://temporary.framer.app"; assert.throws(() => runtime.preparedSyncCredentials(config));
  env.STORE_URL = "https://another.example.invalid"; assert.throws(() => runtime.preparedSyncCredentials(config));
  env.STORE_URL = "https://store.example.invalid"; env.VERCEL_ENV = "preview"; assert.throws(() => runtime.preparedSyncCredentials(config));
});

test("waybill-link checks require an admin and confirmation, preserve the disabled gate and sanitize failures", async () => {
  let authenticated = false, called = 0, fail = false;
  const route = load("../app/api/admin/orders/[orderNumber]/bobgo-sync/route.ts", {
    "@/lib/api-response": { apiJson: (body: any, init: any) => Response.json(body, init), apiOptions: () => new Response(null, { status: 204 }) },
    "@/lib/auth": { getRequestAdmin: async () => authenticated ? { email: "owner@example.invalid" } : null },
    "@/lib/integrations/bobgo/order-sync-runtime": { checkConfiguredBobGoWaybillLink: async () => { called++; if (fail) throw new Error("PRIVATE SECRET"); return { status: "disabled" }; },
      retryConfiguredBobGoSync: () => { throw new Error("Link checks must never enqueue an order"); } },
  });
  const request = (confirm = true) => new Request("https://example.invalid/api/admin/orders/MM-TEST/bobgo-sync", { method: "POST", body: JSON.stringify({ action: "check_waybill", confirm }) });
  const context = { params: Promise.resolve({ orderNumber: "MM-TEST" }) };
  assert.equal((await route.POST(request(), context)).status, 401); assert.equal(called, 0);
  authenticated = true; assert.equal((await route.POST(request(false), context)).status, 400); assert.equal(called, 0);
  assert.equal((await route.POST(request(), context)).status, 503); assert.equal(called, 1);
  fail = true; const response = await route.POST(request(), context); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|SECRET/);
});

test("runner endpoint rejects unauthenticated calls before processing and reports disabled as unavailable, not success", async () => {
  let called = 0, authorized = false;
  const route = load("../app/api/internal/bobgo-sync/route.ts", {
    "@/lib/integrations/bobgo/order-sync-runtime": { isSyncRunnerAuthorized: () => authorized, runConfiguredBobGoSync: async () => { called++; return { enabled: false, ordersChecked: 0 }; } },
    "@/lib/monitoring": { reportFailure: async () => ({ reference: "TEST" }) },
  });
  const request = new Request("https://example.invalid/api/internal/bobgo-sync");
  assert.equal((await route.GET(request)).status, 401); assert.equal(called, 0);
  authorized = true; const result = await route.GET(request); assert.equal(result.status, 503); assert.equal(called, 1);
  assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal((await result.json()).enabled, false);
});

test("saved-package endpoint authenticates before a read-only request and never returns private provider errors", async () => {
  let authenticated = false, failure = false, calls = 0;
  const route = load("../app/api/admin/bobgo/packages/route.ts", {
    "@/lib/api-response": { apiJson: (body: any, init: any) => Response.json(body, init), apiOptions: () => new Response(null, { status: 204 }) },
    "@/lib/auth": { getRequestAdmin: async () => authenticated ? { email: "owner@example.invalid" } : null },
    "@/lib/integrations/bobgo/packages": { parseBobGoPackages },
    "@/lib/integrations/bobgo/client": { bobGoRequest: async (path: string, body: any) => { calls++; assert.equal(path, "/packages"); assert.equal(body, undefined); if (failure) throw new Error("SECRET-PRIVATE-PROVIDER"); return { packages: [{ name: "TEST Package", length_cm: 40, width_cm: 32, height_cm: 6 }] }; } },
  });
  const request = new Request("https://example.invalid/api/admin/bobgo/packages");
  assert.equal((await route.GET(request)).status, 401); assert.equal(calls, 0);
  authenticated = true; const response = await route.GET(request); assert.equal(response.status, 200); assert.equal((await response.json()).packages.length, 1);
  failure = true; const rejected = await route.GET(request); assert.equal(rejected.status, 502); assert.doesNotMatch(await rejected.text(), /SECRET|PRIVATE/);
});
