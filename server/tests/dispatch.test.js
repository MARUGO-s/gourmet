import test from "node:test";
import assert from "node:assert/strict";
import { dispatchWorker } from "../../supabase/functions/_shared/dispatch.js";

test("dispatch uses only the pinned repository workflow and default branch", async () => {
  const result = await dispatchWorker("test-secret", async (url, init) => {
    assert.equal(url, "https://api.github.com/repos/MARUGO-s/gourmet/actions/workflows/sync-worker.yml/dispatches");
    assert.deepEqual(JSON.parse(init.body), { ref: "main" });
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-secret");
    return { status: 200 };
  });
  assert.equal(result.status, "requested");
});
test("missing dispatch key does not call GitHub or pretend started", async () => {
  const result = await dispatchWorker(undefined, () => { throw new Error("must not call"); });
  assert.equal(result.status, "unconfigured");
});
test("authorization failures and transport failures never expose credentials", async () => {
  const denied = await dispatchWorker("secret-value", async () => ({ status: 403 }));
  const failed = await dispatchWorker("secret-value", async () => { throw new Error("secret-value"); });
  assert.equal(denied.status, "failed"); assert.match(denied.message, /403/);
  assert.equal(failed.status, "failed"); assert.ok(!JSON.stringify([denied, failed]).includes("secret-value"));
});
test("legacy successful dispatch response is accepted", async () => {
  assert.equal((await dispatchWorker("test", async () => ({ status: 204 }))).status, "requested");
});
