import assert from "node:assert/strict";
import test from "node:test";
import { linkedStandardCoverMatches } from "../lib/integrations/bobgo/linked-booking-policy.ts";

test("only omitted or explicitly zero declared value matches standard cover", () => {
  assert.equal(linkedStandardCoverMatches({ method: "shipment" }), true);
  for (const declared_value of [0, "0", "0.00", " 0.000 "]) assert.equal(linkedStandardCoverMatches({ declared_value }), true);
  for (const declared_value of [undefined, null, false, true, "", " ", "bad", 450, "450", -1, NaN, Infinity, {}, []]) {
    assert.equal(linkedStandardCoverMatches({ declared_value }), false, `Unexpected cover: ${String(declared_value)}`);
  }
});
