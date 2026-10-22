/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated route harness; no credentials or network. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("daily recovery schedules keep tracking and explicitly activated new-order sync separate", () => {
  const configuration = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(configuration.crons, [{ path: "/api/internal/bobgo-delivery", schedule: "0 5 * * *" }, { path: "/api/internal/bobgo-sync", schedule: "10 5 * * *" }]);
  const runtime = readFileSync(new URL("../lib/integrations/bobgo/delivery-runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtime, /order-sync|runConfiguredBobGoSync|bookShipment|sendEmail/);
  const syncPolicy = readFileSync(new URL("../lib/integrations/bobgo/order-sync-policy.ts", import.meta.url), "utf8");
  assert.match(syncPolicy, /newOrderConfiguration\("BOBGO_ORDER_SYNC_ENABLED"\)/);
});

test("the scheduled recovery handler requires authorization before doing tracking-only work", async () => {
  const mod = { exports: {} as any };
  let calls = 0, fail = false;
  const source = readFileSync(new URL("../app/api/internal/bobgo-delivery/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", compiled)((name: string) => {
    assert.equal(name, "@/lib/integrations/bobgo/delivery-runtime");
    return {
      deliveryRunnerAuthorized: (request: Request) => request.headers.get("authorization") === "Bearer test-only-schedule-credential",
      runDeliveryUpdates: async (reconcile: boolean) => {
        assert.equal(reconcile, true);
        calls++;
        if (fail) throw new Error("PRIVATE PROVIDER DETAILS");
        return { enabled: true, shipmentsChecked: 0, processed: 0, failed: 0 };
      },
    };
  }, mod, mod.exports);
  const request = (authorization?: string) => new Request("https://example.invalid/api/internal/bobgo-delivery", {
    headers: authorization ? { authorization } : {},
  });
  for (const auth of [undefined, "Bearer wrong", "test-only-schedule-credential"]) {
    assert.equal((await mod.exports.GET(request(auth))).status, 401);
    assert.equal(calls, 0);
  }
  const response = await mod.exports.GET(request("Bearer test-only-schedule-credential"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, shipmentsChecked: 0, processed: 0, failed: 0 });
  assert.equal(calls, 1);
  fail = true;
  const error = await mod.exports.GET(request("Bearer test-only-schedule-credential"));
  assert.equal(error.status, 503);
  assert.doesNotMatch(await error.text(), /PRIVATE|PROVIDER/);
});
