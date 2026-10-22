/* eslint-disable @typescript-eslint/no-explicit-any -- Offline route doubles only. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { newOrderConfiguration, isOrderInSyncScope } from "../lib/integrations/bobgo/activation-policy.ts";
import { readLimitedText, RequestBodyError } from "../lib/request-body.ts";

const start = "2026-10-22T13:00:00.000Z";
test("production activation requires an explicit switch and valid persisted cutoff; previews remain off", () => {
  const env = { VERCEL_ENV: "production", BOBGO_ORDER_SYNC_ENABLED: "true", BOBGO_LINKED_BOOKING_ENABLED: "true", BOBGO_NEW_ORDERS_FROM: start };
  const sync = newOrderConfiguration("BOBGO_ORDER_SYNC_ENABLED", env), linked = newOrderConfiguration("BOBGO_LINKED_BOOKING_ENABLED", env);
  assert.deepEqual(sync, linked); assert.equal(sync.enabled, true); assert.equal(sync.createdAfter, start);
  assert.equal(sync.channelRef, "movingmodesty.com"); assert.equal(sync.environment, "production");
  for (const change of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { BOBGO_NEW_ORDERS_FROM: "" },
    { BOBGO_NEW_ORDERS_FROM: "2026-02-30T13:00:00.000Z" }, { BOBGO_NEW_ORDERS_FROM: "2026-10-22T13:00:00" }, { BOBGO_ORDER_SYNC_ENABLED: "false" }]) {
    assert.equal(newOrderConfiguration("BOBGO_ORDER_SYNC_ENABLED", { ...env, ...change }).enabled, false);
  }
  assert.equal(newOrderConfiguration("BOBGO_LINKED_BOOKING_ENABLED", { ...env, BOBGO_ORDER_SYNC_ENABLED: "false" }).enabled, true, "manual linked booking can remain active if automatic copying is later paused");
});

test("scope uses original creation time, never paid/updated time, and never permits production without a cutoff", () => {
  const config = { enabled: true, environment: "production" as const, channelRef: "movingmodesty.com", createdAfter: start };
  assert.equal(isOrderInSyncScope({ createdAt: new Date(Date.parse(start) - 1) }, config), false);
  assert.equal(isOrderInSyncScope({ createdAt: new Date(start) }, config), true);
  assert.equal(isOrderInSyncScope({ createdAt: new Date(Date.parse(start) + 1) }, config), true);
  assert.equal(isOrderInSyncScope({ createdAt: new Date("invalid") }, config), false);
  assert.equal(isOrderInSyncScope({ createdAt: new Date() }, { ...config, createdAfter: undefined }), false);
});

function route(file: string, dependencies: Record<string, any>) {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(source, { exports, Response, require: (name: string) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports;
}

test("payment handoff schedules only verified real paid orders after response; Bob Go failures cannot fail payment", async () => {
  const callbacks: Array<() => Promise<void>> = []; let syncCalls = 0, emails = 0, failSync = false;
  let result: any = { paymentStatus: "paid", orderId: "NEW-TEST-ONLY", courierTest: false };
  const mod = route("../app/api/payments/payfast/notify/route.ts", {
    "@/lib/request-body": { readLimitedText, RequestBodyError },
    "@/lib/integrations/payfast/notification": { processPayFastNotification: async () => result, PayFastNotificationError: class extends Error {}, recordPayFastNotificationFailure: async () => {} },
    "@/lib/email": { sendPaidOrderEmails: async () => { emails++; } },
    "@/lib/monitoring": { reportFailure: async () => ({}), resolveFailures: async () => {} },
    "next/server": { after: (callback: () => Promise<void>) => callbacks.push(callback) },
    "@/lib/integrations/bobgo/order-sync-runtime": { syncConfiguredPaidOrder: async (id: string) => { assert.equal(id, "NEW-TEST-ONLY"); syncCalls++; if (failSync) throw new Error("Offline failure"); } },
  });
  const request = () => new Request("https://example.invalid/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "test-only" });
  assert.equal((await mod.POST(request())).status, 200); assert.equal(syncCalls, 0); assert.equal(emails, 1);
  failSync = true; await callbacks.pop()!(); assert.equal(syncCalls, 1);
  for (const value of [{ ...result, courierTest: true }, { ...result, paymentStatus: "pending" }, { ...result, paymentStatus: "failed" }]) {
    result = value; assert.equal((await mod.POST(request())).status, 200); assert.equal(callbacks.length, 0);
  }
});

test("live activation diagnostic authenticates before read-only permission inspection; never starts a worker", async () => {
  let authenticated = false, reads = 0;
  const mod = route("../app/api/admin/bobgo/sync-status/route.ts", {
    "@/lib/api-response": { apiJson: (body: any, init: any) => Response.json(body, init), apiOptions: () => new Response(null) },
    "@/lib/auth": { getRequestAdmin: async () => authenticated ? {} : null },
    "@/lib/integrations/bobgo/order-sync-policy": { getOrderSyncConfiguration: () => ({ enabled: true, createdAfter: start }) },
    "@/lib/integrations/bobgo/linked-booking-policy": { getLinkedBookingConfiguration: () => ({ enabled: true }) },
    "@/lib/integrations/bobgo/order-sync-runtime": { preparedSyncCredentials: () => ({ token: "TEST-ONLY" }) },
    "@/lib/integrations/bobgo/linked-booking-transport": { createLinkedBookingTransport: () => ({ readPermissions: async () => { reads++; return {}; } }) },
    "@/lib/integrations/bobgo/permissions": { inspectLinkedBookingPermissions: () => ({ allowed: true }), linkedWaybillChangePermissions: [] },
  });
  const request = new Request("https://example.invalid/api/admin/bobgo/sync-status");
  assert.equal((await mod.GET(request)).status, 401); assert.equal(reads, 0);
  authenticated = true; const response = await mod.GET(request); assert.equal(response.status, 200);
  const status = await response.json(); assert.equal(status.orderSyncEnabled, true); assert.equal(status.linkedBookingEnabled, true);
  assert.equal(status.automaticWaybillBooking, false); assert.equal(status.historicalImport, false); assert.equal(reads, 1);
});

test("the existing connection button verifies deployed channel credentials and all write permissions using GET only", async () => {
  let authenticated = false, directReads = 0, channelReads = 0;
  const mod = route("../app/api/admin/bobgo/locations/route.ts", {
    "@/lib/api-response": { apiJson: (body: any, init: any) => Response.json(body, init), apiOptions: () => new Response(null) },
    "@/lib/auth": { getRequestAdmin: async () => authenticated ? {} : null },
    "@/lib/integrations/bobgo/client": { bobGoRequest: async (path: string, body: any) => { assert.equal(body, undefined); assert.equal(path, "/orders?limit=1&offset=0"); directReads++; return {}; } },
    "@/lib/integrations/bobgo/configuration": { getBobGoConfiguration: () => ({ apiTokenConfigured: true, enabled: true, environment: "production" }) },
    "@/lib/monitoring": { reportFailure: async () => ({ reference: "OFFLINE" }) },
    "@/lib/integrations/bobgo/order-sync-policy": { getOrderSyncConfiguration: () => ({ enabled: true, createdAfter: start }) },
    "@/lib/integrations/bobgo/linked-booking-policy": { getLinkedBookingConfiguration: () => ({ enabled: true, createdAfter: start }) },
    "@/lib/integrations/bobgo/order-sync-runtime": { preparedSyncCredentials: () => ({ token: "TEST-ONLY" }) },
    "@/lib/integrations/bobgo/linked-booking-transport": { createLinkedBookingTransport: () => ({ readPermissions: async () => { channelReads++; return {}; } }) },
    "@/lib/integrations/bobgo/permissions": { inspectLinkedBookingPermissions: (_: any, required: string[]) => { assert.ok(required.includes("API_/orders:POST")); return { allowed: true }; }, linkedBookingPermissions: [], linkedWaybillChangePermissions: [] },
  });
  const request = new Request("https://example.invalid/api/admin/bobgo/locations");
  assert.equal((await mod.GET(request)).status, 401); assert.equal(directReads + channelReads, 0);
  authenticated = true; const response = await mod.GET(request); assert.equal(response.status, 200);
  assert.match((await response.json()).target, /New-order sync and linked booking enabled/);
  assert.equal(directReads, 1); assert.equal(channelReads, 1);
});
