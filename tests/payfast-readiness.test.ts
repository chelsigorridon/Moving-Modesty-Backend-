import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePayFastReadiness } from "../lib/integrations/payfast/readiness.ts";

const configured = {
  enabled: true, environment: "production" as const,
  merchantId: "12345678", merchantKey: "fixture-key-not-a-real-key",
  passphrase: "fixture-passphrase-not-a-secret", storeUrl: "https://example.com",
  sourceIpValidation: true,
};

test("live preflight returns availability without returning secrets", () => {
  const result = evaluatePayFastReadiness(configured);
  assert.deepEqual(result, { available: true, environment: "production", issues: [] });
  assert.equal(JSON.stringify(result).includes(configured.merchantKey), false);
  assert.equal(JSON.stringify(result).includes(configured.passphrase), false);
});
test("public PayFast test credentials cannot be used for live checkout", () => {
  assert.equal(evaluatePayFastReadiness({ ...configured, merchantId: "10000100" }).available, false);
  assert.equal(evaluatePayFastReadiness({ ...configured, merchantKey: "46f0cd694581a" }).available, false);
  assert.equal(evaluatePayFastReadiness({ ...configured, merchantId: "10004002", merchantKey: "q1cd2rdny4a53" }).available, false);
});
test("sandbox can still use PayFast's documented test credentials", () => {
  assert.equal(evaluatePayFastReadiness({ ...configured, environment: "sandbox", merchantId: "10000100", merchantKey: "46f0cd694581a", sourceIpValidation: false }).available, true);
});
test("live preflight rejects disabled checkout, incomplete secrets and insecure settings", () => {
  for (const patch of [{ enabled: false }, { merchantId: "" }, { merchantKey: "PASTE_KEY" },
    { passphrase: "" }, { storeUrl: "http://example.com" }, { sourceIpValidation: false }]) {
    assert.equal(evaluatePayFastReadiness({ ...configured, ...patch }).available, false);
  }
});
