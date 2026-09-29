import assert from "node:assert/strict";
import test from "node:test";
import {
  createPayFastNotificationSignature,
  createPayFastSignature,
  fieldsFromSearchParams,
  payFastNotificationParameterString,
  payFastParameterString,
  signaturesMatch,
  type PayFastField,
} from "../lib/integrations/payfast/signature.ts";

const fields: PayFastField[] = [
  ["merchant_id", "10004002"],
  ["merchant_key", "q1cd2rdny4a53"],
  ["return_url", "https://example.com/success"],
  ["amount", "100.00"],
  ["item_name", "Test Item"],
];

test("PayFast signatures use field order, PHP-style encoding, and the passphrase", () => {
  assert.equal(
    payFastParameterString(fields, "payfast"),
    "merchant_id=10004002&merchant_key=q1cd2rdny4a53&return_url=https%3A%2F%2Fexample.com%2Fsuccess&amount=100.00&item_name=Test+Item&passphrase=payfast",
  );
  assert.equal(createPayFastSignature(fields, "payfast"), "16c7fcb6fa3e97ba406f6f96b48f7040");
});

test("blank values and a received signature are excluded from signature generation", () => {
  assert.equal(
    payFastParameterString([
      ["merchant_id", "10004002"],
      ["custom_str1", ""],
      ["signature", "do-not-sign-this"],
      ["item_name", "Hawa & Amina * set"],
    ]),
    "merchant_id=10004002&item_name=Hawa+%26+Amina+%2A+set",
  );
});

test("notification fields retain their received order", () => {
  const params = new URLSearchParams("merchant_id=10004002&amount_gross=549.00&signature=abc");
  assert.deepEqual(fieldsFromSearchParams(params), [
    ["merchant_id", "10004002"],
    ["amount_gross", "549.00"],
    ["signature", "abc"],
  ]);
});

test("notification signatures preserve blank callback fields and stop before signature", () => {
  const params = new URLSearchParams(
    "m_payment_id=MM-TEST-1&pf_payment_id=123&payment_status=COMPLETE&item_name=Test+product&item_description=&amount_gross=840.00&custom_str1=&merchant_id=10004002&signature=received",
  );
  assert.equal(
    payFastNotificationParameterString(params),
    "m_payment_id=MM-TEST-1&pf_payment_id=123&payment_status=COMPLETE&item_name=Test+product&item_description=&amount_gross=840.00&custom_str1=&merchant_id=10004002",
  );
  assert.equal(
    createPayFastNotificationSignature(params, "payfast"),
    "d3959dd7a4ad5a4c1aa3cd09c1fc78a6",
  );
});

test("signature comparison is case insensitive and rejects mismatches", () => {
  assert.equal(signaturesMatch("ABC123", "abc123"), true);
  assert.equal(signaturesMatch("abc123", "abc124"), false);
  assert.equal(signaturesMatch("short", "longer"), false);
});
