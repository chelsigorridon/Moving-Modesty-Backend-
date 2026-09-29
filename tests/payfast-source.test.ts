import assert from "node:assert/strict";
import test from "node:test";
import { isPublishedPayFastIp } from "../lib/integrations/payfast/source.ts";

test("PayFast's published IPv4 ranges are accepted", () => {
  assert.equal(isPublishedPayFastIp("197.97.145.144"), true);
  assert.equal(isPublishedPayFastIp("197.97.145.159"), true);
  assert.equal(isPublishedPayFastIp("41.74.179.223"), true);
  assert.equal(isPublishedPayFastIp("102.216.36.139"), true);
  assert.equal(isPublishedPayFastIp("144.126.193.139"), true);
  assert.equal(isPublishedPayFastIp("::ffff:144.126.193.139"), true);
});

test("addresses outside PayFast's published ranges are rejected", () => {
  assert.equal(isPublishedPayFastIp("197.97.145.143"), false);
  assert.equal(isPublishedPayFastIp("197.97.145.160"), false);
  assert.equal(isPublishedPayFastIp("102.216.36.127"), false);
  assert.equal(isPublishedPayFastIp("203.0.113.10"), false);
  assert.equal(isPublishedPayFastIp("not-an-ip"), false);
});
