import test from "node:test";
import assert from "node:assert/strict";
import { createSyncJobs } from "../sync-jobs.js";

const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("開始応答は即時、進捗を取得でき、同じユーザーの重複実行を防ぐ", async () => {
  const jobs = createSyncJobs(); const pending = deferred(); let calls = 0;
  const first = jobs.start("user-a", ["tabelog"], async (update) => {
    calls++; update({ step: "daily_pv", message: "PV取得中" }); return pending.promise;
  });
  assert.equal(first.job.status, "running");
  const second = jobs.start("user-a", ["tabelog"], () => assert.fail("重複実行"));
  assert.equal(second.reused, true); assert.equal(second.job.id, first.job.id);
  await flush();
  assert.equal(calls, 1); assert.equal(jobs.active("user-a").step, "daily_pv");
  pending.resolve([{ source: "tabelog", status: "ok" }]); await flush();
  assert.equal(jobs.active("user-a"), null);
  assert.equal(jobs.get("user-a", first.job.id).status, "completed");
});

test("他ユーザーの進捗・結果を返さず、返却値から内部状態を変更できない", async () => {
  const jobs = createSyncJobs(); const pending = deferred();
  const { job } = jobs.start("user-a", ["tabelog"], () => pending.promise);
  assert.equal(jobs.get("user-b", job.id), null); assert.equal(jobs.active("user-b"), null);
  assert.equal("userId" in job, false);
  job.sources.push("modified");
  assert.deepEqual(jobs.get("user-a", job.id).sources, ["tabelog"]);
  pending.resolve([]); await flush();
});

test("失敗時も必ず終了し、資格情報を含み得る例外は公開しない", async () => {
  const jobs = createSyncJobs();
  const { job } = jobs.start("user-a", ["tabelog"], () => { throw new Error("secret-token"); });
  await flush();
  const result = jobs.get("user-a", job.id);
  assert.equal(result.status, "error"); assert.ok(result.finishedAt);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(jobs.active("user-a"), null);
});

test("保存失敗を含む結果はジョブ全体でも失敗を表示", async () => {
  const jobs = createSyncJobs();
  const { job } = jobs.start("user-a", ["tabelog"], async () => [{ source: "tabelog", status: "error", step: "save" }]);
  await flush(); assert.equal(jobs.get("user-a", job.id).status, "error");
});

test("ブラウザ同時実行数を制限し、終了後は次のユーザーが開始可能", async () => {
  const jobs = createSyncJobs({ maxRunning: 1 }); const pending = deferred();
  jobs.start("user-a", ["tabelog"], () => pending.promise);
  assert.equal(jobs.start("user-b", ["tabelog"], async () => []).busy, true);
  pending.resolve([]); await flush();
  assert.equal(jobs.start("user-b", ["tabelog"], async () => []).job.status, "running");
  await flush();
});

test("終了ジョブは保持期間後に破棄する", async () => {
  let now = 1000; const jobs = createSyncJobs({ now: () => now, retentionMs: 100 });
  const { job } = jobs.start("user-a", ["tabelog"], async () => []); await flush();
  now += 101; jobs.start("user-b", ["tabelog"], async () => []);
  assert.equal(jobs.get("user-a", job.id), null); await flush();
});
