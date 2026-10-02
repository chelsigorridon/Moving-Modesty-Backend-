import assert from "node:assert/strict";
import test from "node:test";
import { paymentEnvironmentFromProvider } from "../lib/payment-environment.ts";

test("live and sandbox payments are classified by their persisted provider", () => {
  assert.equal(paymentEnvironmentFromProvider("payfast-production"), "production");
  assert.equal(paymentEnvironmentFromProvider("payfast-sandbox"), "sandbox");
});
test("legacy or missing payment metadata is not treated as live revenue", () => {
  for (const value of ["payfast", "", null, undefined, "bobgo-production"]) {
    assert.equal(paymentEnvironmentFromProvider(value), "unknown");
  }
});
