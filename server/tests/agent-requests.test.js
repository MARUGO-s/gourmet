import test from "node:test";
import assert from "node:assert/strict";
import { validateRequestInput, validateFinish, publicRequest, STATUS_LABELS, REQUEST_ACTIONS } from "../../supabase/functions/_shared/agent-requests.js";
import { queueCommand } from "../../scripts/agent-queue.mjs";
import { requestLabel, openRequestFor, hasOpenRequests, STATUS_LABELS as UI_STATUS, ACTION_LABELS as UI_ACTIONS, AGENT_POLL_MINUTES as UI_POLL } from "../../src/lib/agent-requests.ts";
import { ACTION_LABELS, AGENT_POLL_MINUTES } from "../../supabase/functions/_shared/agent-requests.js";

const ID = "3f2b8a4e-1111-4222-8333-944445555666";

test("browser requests are validated per store and source", () => {
  assert.deepEqual(validateRequestInput({ source: "tabelog", storeId: "13245351" }, "2026-09"), { source: "tabelog", store_id: "13245351", action: "sync_now", params: {} });
  assert.deepEqual(validateRequestInput({ source: "ikyu", storeId: "112789", action: "backfill", params: { fromMonth: "2025-01" } }, "2026-09").params, { fromMonth: "2025-01", toMonth: "2026-09" });
  for (const bad of [{ source: "x" }, { source: "ikyu", storeId: "" }, { source: "tabelog", action: "delete" }, { source: "tabelog", storeId: "店" },
    { source: "google", action: "backfill", params: {} }, { source: "google", action: "backfill", params: { fromMonth: "2026-10" } },
    { source: "google", action: "backfill", params: { fromMonth: "2010-01" } }, { source: "google", params: { note: "x".repeat(201) } }]) {
    assert.throws(() => validateRequestInput(bad, "2026-09"), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(REQUEST_ACTIONS, ["sync_now", "fetch_metrics", "fetch_reviews", "backfill"]);
});

test("agent completion requires the claim id; failures need a reason", () => {
  assert.deepEqual(validateFinish({ id: ID, claimId: ID, result: { days: 3 } }, "done"), { id: ID, claimId: ID, result: { days: 3 }, error: null });
  assert.throws(() => validateFinish({ id: ID }, "done"), /claimId/);
  assert.throws(() => validateFinish({ id: ID, claimId: ID }, "failed"), /error/);
  assert.equal(validateFinish({ id: ID, claimId: ID, error: "追加認証が必要でした" }, "failed").error, "追加認証が必要でした");
});

test("public rows hide the claim id from the browser shape", () => {
  const row = publicRequest({ id: ID, source: "tabelog", store_id: "1", action: "sync_now", params: {}, status: "claimed", requested_at: "t", claim_id: ID });
  assert.equal("claimId" in row, false);
  assert.equal(row.storeId, "1");
});

test("status labels read 依頼中/取得中/完了/失敗 and open requests are detected per store×source×action", () => {
  assert.deepEqual(STATUS_LABELS, { queued: "依頼中", claimed: "取得中", done: "完了", failed: "失敗" });
  assert.equal(requestLabel("claimed"), "取得中");
  assert.deepEqual(UI_STATUS, STATUS_LABELS); assert.deepEqual(UI_ACTIONS, ACTION_LABELS); assert.equal(UI_POLL, AGENT_POLL_MINUTES);
  const rows = [{ source: "tabelog", storeId: "1", action: "sync_now", status: "done" }, { source: "tabelog", storeId: "1", action: "sync_now", status: "queued" }];
  assert.equal(openRequestFor(rows, "tabelog", "1", "sync_now")?.status, "queued");
  assert.equal(openRequestFor(rows, "tabelog", "2", "sync_now"), undefined);
  assert.equal(hasOpenRequests(rows), true);
  assert.equal(hasOpenRequests([rows[0]]), false);
});

test("agent-queue CLI maps flags to agent-api actions", () => {
  assert.deepEqual(queueCommand({ _: [], list: true }), { path: "/requests/pending", body: {} });
  assert.deepEqual(queueCommand({ _: [], claim: true, source: "ikyu", limit: "3" }), { path: "/requests/claim", body: { agent: "grok-bot", limit: 3, source: "ikyu" } });
  assert.deepEqual(queueCommand({ _: [], complete: ID, "claim-id": ID, result: '{"days":30}' }), { path: "/requests/complete", body: { id: ID, claimId: ID, result: { days: 30 } } });
  assert.deepEqual(queueCommand({ _: [], fail: ID, "claim-id": ID, error: "ログイン不可" }), { path: "/requests/fail", body: { id: ID, claimId: ID, error: "ログイン不可" } });
  assert.throws(() => queueCommand({ _: [], list: true, claim: true }));
  assert.throws(() => queueCommand({ _: [], fail: ID, "claim-id": ID }), /--error/);
  assert.throws(() => queueCommand({ _: [], claim: true, limit: "50" }), /limit/);
});
