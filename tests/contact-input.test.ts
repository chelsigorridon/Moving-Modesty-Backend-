import assert from "node:assert/strict";
import test from "node:test";
import { contactInputSchema, contactOriginAllowed } from "../lib/contact-input.ts";

const valid = { submissionId: "c4c5b18e-4e64-4d3b-845e-d6432157f723", name: " Zarina ", email: "CLIENT@EXAMPLE.COM", message: "Please help with my order." };
test("contact validates and normalizes customer input", () => {
  const input = contactInputSchema.parse(valid);
  assert.equal(input.name, "Zarina");
  assert.equal(input.email, "client@example.com");
  assert.equal(input.website, "");
});
test("contact rejects invalid or oversized submissions", () => {
  for (const override of [{ submissionId: "x" }, { email: "invalid" }, { name: " " }, { message: "short" }, { message: "x".repeat(4001) }]) {
    assert.equal(contactInputSchema.safeParse({ ...valid, ...override }).success, false);
  }
});
test("contact origin must match the configured storefront or backend exactly", () => {
  const request = "https://movingmodesty.vercel.app/api/contact";
  const store = "https://holistic-brand-492217.framer.app";
  assert.equal(contactOriginAllowed(store, request, store), true);
  assert.equal(contactOriginAllowed("https://movingmodesty.vercel.app", request, store), true);
  for (const origin of [null, "null", "https://evil.framer.app", "https://holistic-brand-492217.framer.app.evil.com", store + "/page"]) {
    assert.equal(contactOriginAllowed(origin, request, store), false);
  }
});
