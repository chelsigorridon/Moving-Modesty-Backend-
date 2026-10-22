/* eslint-disable @typescript-eslint/no-explicit-any -- Route-level test doubles only. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
test("read-only connection checks verify account access without requiring a locker or exposing any orders", async () => {
  let authenticated = false, failure = false, calls = 0;
  const config = { enabled: true, environment: "sandbox", apiTokenConfigured: true };
  function route(file: string) {
    const loaded = { exports: {} as any };
    const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name.endsWith("/api-response")) return { apiJson: (body: any, options?: ResponseInit) => Response.json(body, options), apiOptions: () => new Response(null, { status: 204 }) };
      if (name.endsWith("/auth")) return { getRequestAdmin: async () => authenticated ? { email: "owner@example.invalid" } : null };
      if (name.endsWith("bobgo/configuration")) return { getBobGoConfiguration: () => config };
      if (name.endsWith("bobgo/order-sync-policy")) return { getOrderSyncConfiguration: () => ({ enabled: false }) };
      if (name.endsWith("bobgo/linked-booking-policy")) return { getLinkedBookingConfiguration: () => ({ enabled: false }) };
      if (["bobgo/order-sync-runtime", "bobgo/linked-booking-transport", "bobgo/permissions"].some(path => name.endsWith(path))) return {};
      if (name.endsWith("payfast/configuration")) return { getPayFastConfiguration: () => ({ environment: "sandbox" }) };
      if (name.endsWith("/monitoring")) return { reportFailure: async () => ({ reference: "TEST-REF" }), resolveFailures: async () => {} };
      if (name.endsWith("/admin-data")) return { getAdminSnapshot: async () => ({ orders: [], products: [] }) };
      if (name.endsWith("bobgo/client")) return { bobGoRequest: async (path: string, body: unknown) => {
        calls++; assert.equal(path, "/orders?limit=1&offset=0"); assert.equal(body, undefined);
        if (failure) throw new Error("TEST SECRET PRIVATE ORDER ERROR");
        return { orders: [{ customer_email: "PRIVATE@example.invalid", delivery_address: "PRIVATE ADDRESS" }] };
      } };
      return require(name);
    }, loaded, loaded.exports);
    return loaded.exports;
  }
  const connection = route("../app/api/admin/bobgo/locations/route.ts"), data = route("../app/api/admin/data/route.ts");
  const request = new Request("https://example.invalid/api/admin/bobgo/locations");
  assert.equal((await connection.GET(request)).status, 401); assert.equal(calls, 0);
  authenticated = true;
  const result = await connection.GET(request); assert.equal(result.status, 200);
  const json = await result.json(); assert.equal(json.connected, true); assert.equal(json.checkScope, "account_read_only");
  assert.doesNotMatch(JSON.stringify(json), /PRIVATE|SECRET|Constantia|customer_email/);
  const before = calls, snapshot = await (await data.GET(request)).json();
  assert.equal(snapshot.bobGoConnection.configured, true); assert.equal(snapshot.bobGoSetup, null); assert.equal(calls, before, "Loading orders never probes a fixed locker");
  failure = true;
  const failed = await connection.GET(request); assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /PRIVATE|SECRET/);
  config.apiTokenConfigured = false;
  const count = calls; assert.equal((await connection.GET(request)).status, 503); assert.equal(calls, count);
});
