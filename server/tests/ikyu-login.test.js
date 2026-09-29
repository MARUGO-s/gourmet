import test from "node:test";
import assert from "node:assert/strict";
import { packIkyuUsername, unpackIkyuUsername } from "../../supabase/functions/_shared/ikyu-login.js";

test("ikyu login keeps the 6-digit store id separate from the operator id", () => {
  const packed = packIkyuUsername("132453", "operator-1");
  assert.equal(unpackIkyuUsername(packed)?.storeId, "132453");
  assert.equal(unpackIkyuUsername(packed)?.operatorId, "operator-1");
  assert.equal(packIkyuUsername("12345", "operator-1"), null);
  assert.equal(packIkyuUsername("1234567", "operator-1"), null);
  assert.equal(packIkyuUsername("132453", ""), null);
});
