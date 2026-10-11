import test from "node:test";
import assert from "node:assert/strict";
import { notifyRefetchWebhook, webhookBody, webhookConfig } from "../../supabase/functions/_shared/refetch-webhook.js";

const env = (o) => (k) => o[k];
const ENV = { GROKBOT_REFETCH_WEBHOOK_URL: "https://hooks.example/run", GROKBOT_REFETCH_WEBHOOK_KEY: "k-secret" };
const ROW = { id: "r1", source: "tabelog", store_id: "13245351", requested_at: "2026-10-11T10:00:00Z", origin: "app", user_id: "u", params: { note: "x" } };

test("skips silently when secrets are missing or the request is scheduled", async () => {
  let called = 0; const fetch = async () => { called++; return { ok: true }; };
  assert.equal(await notifyRefetchWebhook(ROW, { getEnv: env({}), fetch }), "skipped_config");
  assert.equal(await notifyRefetchWebhook(ROW, { getEnv: env({ GROKBOT_REFETCH_WEBHOOK_URL: ENV.GROKBOT_REFETCH_WEBHOOK_URL }), fetch }), "skipped_config");
  assert.equal(await notifyRefetchWebhook({ ...ROW, origin: "schedule" }, { getEnv: env(ENV), fetch }), "skipped_schedule");
  assert.equal(webhookConfig(env({ ...ENV, GROKBOT_REFETCH_WEBHOOK_URL: "http://x" })), null);
  assert.equal(called, 0);
});

test("posts a small body with both key headers", async () => {
  let seen; const fetch = async (url, init) => { seen = { url, init }; return { ok: true }; };
  assert.equal(await notifyRefetchWebhook(ROW, { getEnv: env(ENV), fetch, recentOtherRequests: async () => 0 }), "sent");
  assert.equal(seen.url, ENV.GROKBOT_REFETCH_WEBHOOK_URL);
  assert.equal(seen.init.headers.Authorization, "Bearer k-secret");
  assert.equal(seen.init.headers["X-Webhook-Key"], "k-secret");
  assert.deepEqual(JSON.parse(seen.init.body), { requestId: "r1", source: "tabelog", storeId: "13245351", requestedAt: "2026-10-11T10:00:00Z" });
  assert.deepEqual(webhookBody(ROW), JSON.parse(seen.init.body));
});

test("debounces when another request came in within 2 minutes", async () => {
  let called = 0; let since;
  const r = await notifyRefetchWebhook(ROW, { getEnv: env(ENV), fetch: async () => { called++; return { ok: true }; }, now: () => Date.parse("2026-10-11T10:00:00Z"),
    recentOtherRequests: async (s, id) => { since = s; assert.equal(id, "r1"); return 1; } });
  assert.equal(r, "debounced"); assert.equal(called, 0); assert.equal(since, "2026-10-11T09:58:00.000Z");
});

test("failures and timeouts never throw and never log the key or URL", async () => {
  const logs = []; const log = (m) => logs.push(m);
  assert.equal(await notifyRefetchWebhook(ROW, { getEnv: env(ENV), log, fetch: async () => ({ ok: false, status: 500 }) }), "failed");
  assert.equal(await notifyRefetchWebhook(ROW, { getEnv: env(ENV), log, fetch: async () => { throw new Error("boom k-secret"); } }), "failed");
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
  assert.equal(await notifyRefetchWebhook(ROW, { getEnv: env(ENV), log, fetch: hang, timeoutMs: 20 }), "failed");
  assert.deepEqual(logs, ["refetch webhook: HTTP 500", "refetch webhook: error", "refetch webhook: timeout"]);
  assert.ok(logs.every((l) => !l.includes("k-secret") && !l.includes("hooks.example")));
});
