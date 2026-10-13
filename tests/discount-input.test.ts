import assert from "node:assert/strict";
import test from "node:test";
import { discountSaveSchema, discountSaving } from "../lib/discount-input.ts";

const rule = { active: true, type: "percentage", value: 10, minimumSpend: 0, startsAt: null, endsAt: null, productIds: [] as string[] };
const lines = [{ productId: "amina", lineTotal: 420 }, { productId: "hawa", lineTotal: 450 }];
test("discount creation starts off, accepts user-defined uppercase shared codes and has no campaign defaults", () => {
  const parsed = discountSaveSchema.parse({ expectedRevision: 0, code: "  welcome_10 ", type: "percentage", value: 10 });
  assert.equal(parsed.code, "WELCOME_10"); assert.equal(parsed.active, false);
  assert.deepEqual(parsed.productIds, []); assert.equal(parsed.startsAt, null); assert.equal(parsed.endsAt, null);
  for (const code of ["", "a", "A B", "<script>"]) assert.equal(discountSaveSchema.safeParse({ ...parsed, code }).success, false);
  for (const value of [0, -1, 100, 101, NaN, 1.234]) assert.equal(discountSaveSchema.safeParse({ ...parsed, value }).success, false);
  assert.equal(discountSaveSchema.safeParse({ ...parsed, startsAt: "2026-10-10T00:00:00Z", endsAt: "2026-10-09T00:00:00Z" }).success, false);
});
test("percentage and fixed discounts use eligible product cents; minimum spend, dates and OFF are enforced", () => {
  assert.equal(discountSaving(rule, lines), 87);
  assert.equal(discountSaving({ ...rule, productIds: ["amina"] }, lines), 42);
  assert.equal(discountSaving({ ...rule, type: "amount", value: 500, productIds: ["amina"] }, lines), 420);
  assert.equal(discountSaving({ ...rule, value: 15 }, [{ lineTotal: 19.99 }]), 3);
  for (const invalid of [{ active: false }, { startsAt: new Date("2099-01-01") }, { endsAt: new Date("2000-01-01") }, { minimumSpend: 900 }, { productIds: ["other"] }]) {
    assert.throws(() => discountSaving({ ...rule, ...invalid }, lines));
  }
  assert.throws(() => discountSaving({ ...rule, type: "amount", value: 900 }, lines), /products free/);
  const now = new Date("2026-10-10T00:00:00Z");
  assert.equal(discountSaving({ ...rule, startsAt: now }, lines, now), 87);
  assert.throws(() => discountSaving({ ...rule, endsAt: now }, lines, now), /not currently available/);
});
