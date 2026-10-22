/* eslint-disable @typescript-eslint/no-explicit-any -- Actual handler with synthetic dependencies; no live payment/DB/network. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { readLimitedText, RequestBodyError } from "../lib/request-body.ts";

function execute(file: string, dependencies: Record<string, unknown>): any {
  const compiledModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL("../" + file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", code)((name: string) => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; }, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

test("invalid PayFast signature cannot write payment metadata or attach an untrusted order reference to an alert", async () => {
  const incidents: any[] = [];
  const forbidden = () => { assert.fail("Invalid notification must not read/write payment data, send emails or sync"); };
  const notification = execute("lib/integrations/payfast/notification.ts", {
    "server-only": {}, "@/lib/catalogue-storefront": { deductPaidStock: forbidden }, "drizzle-orm": {},
    "@/lib/db": { requireDatabase: forbidden }, "@/lib/db/schema": {}, "@/lib/checkout-safety": {},
    "@/lib/integrations/bobgo/order-sync": { enqueuePaidBobGoOrder: forbidden },
    "./configuration": { requirePayFastConfiguration: () => ({ merchantId: "TEST", passphrase: "TEST-ONLY" }) },
    "./signature": { createPayFastNotificationSignature: () => "TEST-EXPECTED", signaturesMatch: () => false }, "./source": {},
    "../../live-courier-test": { isLiveCourierTestNumber: () => false },
  });
  const handler = execute("app/api/payments/payfast/notify/route.ts", {
    "@/lib/integrations/payfast/notification": notification,
    "@/lib/monitoring": { reportFailure: async (_error: unknown, context: any) => incidents.push(context), resolveFailures: forbidden },
    "next/server": { after: forbidden }, "@/lib/email": { sendPaidOrderEmails: forbidden },
    "@/lib/integrations/bobgo/order-sync-runtime": { syncConfiguredPaidOrder: forbidden },
    "@/lib/request-body": { readLimitedText, RequestBodyError },
  });
  const post = (body: string, contentType = "application/x-www-form-urlencoded") => handler.POST(new Request("https://synthetic.invalid", { method: "POST", headers: { "content-type": contentType }, body }));
  assert.equal((await post("m_payment_id=UNTRUSTED-CUSTOMER-ORDER&signature=INVALID")).status, 400);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].orderNumber, undefined);
  assert.equal(incidents[0].orderId, undefined);
  assert.equal(incidents[0].alert, false);
  assert.equal(notification.recordPayFastNotificationFailure, undefined);
  assert.equal((await post("x".repeat(16_385))).status, 413);
  assert.equal((await post("{}", "application/json")).status, 415);
  assert.equal(incidents.length, 1);
});
