import test from "node:test";
import assert from "node:assert/strict";
import { headerSync, unconnectedSyncMessage } from "../../src/lib/sync-availability.ts";

const sources = [
  { id: "tabelog", name: "食べログ", hasCredential: true },
  { id: "ikyu", name: "一休.comレストラン", hasCredential: true },
  { id: "retty", name: "Retty", hasCredential: false },
];

test("ikyu stays clickable after the account is saved", () => {
  const sync = headerSync(true, "ikyu", sources);
  assert.equal(sync.enabled, true);
  if (!sync.enabled || sync.mode !== "unconnected") return;
  assert.equal(sync.hasCredential, true);
  assert.match(unconnectedSyncMessage(sync.name, sync.hasCredential), /保存済み/);
  assert.match(unconnectedSyncMessage(sync.name, sync.hasCredential), /開始していません/);
});

test("a site without an account still opens from the sync button", () => {
  const sync = headerSync(true, "retty", sources);
  assert.equal(sync.enabled, true);
  if (!sync.enabled || sync.mode !== "unconnected") return;
  assert.equal(sync.hasCredential, false);
});

test("tabelog sync stays available on the all and tabelog filters", () => {
  assert.deepEqual(headerSync(true, "all", sources), { enabled: true, mode: "tabelog" });
  assert.deepEqual(headerSync(true, "tabelog", sources), { enabled: true, mode: "tabelog" });
  assert.equal(headerSync(true, "tabelog", sources.map((s) => s.id === "tabelog" ? { ...s, hasCredential: false } : s)).enabled, false);
  assert.equal(headerSync(false, "ikyu", sources).enabled, false);
});
