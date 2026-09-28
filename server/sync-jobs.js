import { randomUUID } from "node:crypto";

// ローカルの単一APIプロセス用。資格情報・トークンはジョブに含めない。
export function createSyncJobs({ now = Date.now, retentionMs = 60 * 60_000, maxRunning = 2 } = {}) {
  const jobs = new Map();
  const view = ({ userId, ...job }) => structuredClone(job);
  const active = (userId) => [...jobs.values()].find((job) => job.userId === userId && job.status === "running");
  function start(userId, sources, run) {
    for (const [id, job] of jobs) {
      if (job.finishedAt && now() - Date.parse(job.finishedAt) > retentionMs) jobs.delete(id);
    }
    const existing = active(userId);
    if (existing) return { job: view(existing), reused: true };
    if ([...jobs.values()].filter((j) => j.status === "running").length >= maxRunning) {
      return { busy: true };
    }
    const job = {
      id: randomUUID(), userId, sources, status: "running", step: "queued",
      message: "同期を準備しています", startedAt: new Date(now()).toISOString(),
      finishedAt: null, results: [],
    };
    jobs.set(job.id, job);
    const update = (progress) => {
      if (job.status === "running") Object.assign(job, progress);
    };
    // start() 内でロックを確保した後に実行し、HTTP応答とは独立して完了させる。
    Promise.resolve().then(() => run(update)).then((results) => {
      job.results = results;
      job.status = results.some((r) => r.status === "error") ? "error" : "completed";
      job.message = job.status === "completed" ? "同期が完了しました" : "同期結果を確認してください";
    }).catch(() => {
      job.status = "error";
      job.message = "同期処理に失敗しました。時間をおいて再実行してください";
      job.results = sources.map((source) => ({ source, status: "error", step: "unexpected", message: job.message }));
    }).finally(() => {
      job.step = "finished";
      job.finishedAt = new Date(now()).toISOString();
    });
    return { job: view(job), reused: false };
  }
  return {
    start,
    active: (userId) => { const job = active(userId); return job ? view(job) : null; },
    get: (userId, id) => { const job = jobs.get(id); return job?.userId === userId ? view(job) : null; },
  };
}
