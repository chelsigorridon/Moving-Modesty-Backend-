/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic handlers and fake transport; never a real order/payment. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { readLimitedJson, RequestBodyError } from "../lib/request-body.ts";
import { z } from "zod";

for (const [file, scope, maximum] of [["checkout/orders", "save", 32768], ["checkout/session", "recover", 2048], ["payments/payfast/checkout", "payment", 2048]] as const) {
  test(`${scope} rejects oversized/unsupported/limited requests before order or payment operations`, async () => {
    const allowed = false;
    let outage = false, attempts = 0;
    const forbidden = () => assert.fail("Protected request must not read/write orders, payments, emails or sync");
    const dependencies: Record<string, any> = {
      zod: { z }, "drizzle-orm": {},
      "@/lib/api-response": { apiJson: (body: any, init: any) => Response.json(body, init), apiOptions: () => new Response(null) },
      "@/lib/request-body": { readLimitedJson, RequestBodyError },
      "@/lib/checkout-rate-limit": { consumeCheckoutAttempt: async (_request: unknown, operation: string) => {
        assert.equal(operation, scope); attempts++; if (outage) throw new Error("TEST limiter outage"); return { allowed, retryAfter: 120 };
      } },
      "@/lib/monitoring": { reportFailure: async () => ({ reference: "TEST-REF" }), resolveFailures: forbidden },
      "@/lib/checkout-order": { checkoutOrderSchema: { safeParse: (data: unknown) => ({ success: true, data }) }, upsertCheckoutOrder: forbidden, CheckoutValidationError: class extends Error {} },
      "@/lib/checkout-safety": { CheckoutConflictError: class extends Error {}, readOrderCustomer: forbidden },
      "@/lib/discount-input": { DiscountValidationError: class extends Error {} },
      "@/lib/db": { requireDatabase: forbidden }, "@/lib/db/schema": {},
      "@/lib/integrations/payfast/configuration": { getPayFastCheckoutReadiness: () => ({ ready: true }) },
      "@/lib/integrations/payfast/checkout": { createPayFastCheckout: forbidden, recordPayFastCheckoutFailure: forbidden, PayFastCheckoutError: class extends Error {}, payFastCheckoutSchema: { safeParse: (data: unknown) => ({ success: true, data }) } },
    };
    const compiledModule = { exports: {} as any };
    const compiled = ts.transpileModule(readFileSync(new URL(`../app/api/${file}/route.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, compiledModule, compiledModule.exports);
    const payload = scope === "recover" ? JSON.stringify({ checkoutToken: "8ee09619-8587-4bb0-99a7-6163d3e086ab", orderNumber: "MM-TEST-ONLY" }) : "{}";
    const post = (body = payload, type = "application/json") => compiledModule.exports.POST(new Request("https://synthetic.invalid", { method: "POST", body, headers: { "content-type": type } }));
    assert.equal((await post("x".repeat(maximum + 1))).status, 413);
    assert.equal((await post("{}", "text/plain")).status, 415);
    assert.equal((await post("{")).status, 400);
    assert.equal(attempts, 0);
    const blocked = await post();
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get("Retry-After"), "120");
    outage = true;
    assert.equal((await post()).status, 503);
    assert.equal(attempts, 2);
    if (scope === "payment") assert.equal((await compiledModule.exports.GET()).status, 200, "Preflight stays read-only and usable");
  });
}
