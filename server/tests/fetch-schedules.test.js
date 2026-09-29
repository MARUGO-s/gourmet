import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  computeNextDue, validateScheduleInput, nextDueOnSave, describeSchedule, publicSchedule, enqueueDueSchedules, timeOutsideAgentWindow, inAgentWindow,
  SCHEDULE_SOURCES, SCHEDULE_MODES, SUPPORTED_SCHEDULE_SOURCES,
} from "../../supabase/functions/_shared/fetch-schedules.js";
import { queueCommand } from "../../scripts/agent-queue.mjs";

// 2026-09-29(火) 20:55 JST = 11:55Z
const NOW = "2026-09-29T11:55:00.000Z";

test("毎日○時は日本時間で次の時刻（当日が過ぎていれば翌日）", () => {
  assert.equal(computeNextDue({ mode: "daily", time_of_day: "21:00" }, NOW), "2026-09-29T12:00:00.000Z");
  assert.equal(computeNextDue({ mode: "daily", time_of_day: "10:00:00" }, NOW), "2026-09-30T01:00:00.000Z");
  // ちょうどその時刻は次の日（同じ時刻に二重に依頼しない）
  assert.equal(computeNextDue({ mode: "daily", time_of_day: "20:55" }, NOW), "2026-09-30T11:55:00.000Z");
  // UTCでは前日でも、日本時間の日付で判定する（JST 2026-09-30 08:00 = 09-29 23:00Z）
  assert.equal(computeNextDue({ mode: "daily", time_of_day: "09:00" }, "2026-09-29T23:00:00Z"), "2026-09-30T00:00:00.000Z");
  assert.equal(computeNextDue({ mode: "daily", time_of_day: "00:30" }, "2026-09-29T15:10:00Z"), "2026-09-29T15:30:00.000Z");
});

test("毎週○曜○時は日本時間の曜日で判定する", () => {
  // 火曜 20:55 JST 時点
  assert.equal(computeNextDue({ mode: "weekly", weekday: 2, time_of_day: "21:00" }, NOW), "2026-09-29T12:00:00.000Z"); // 今日（火）
  assert.equal(computeNextDue({ mode: "weekly", weekday: 2, time_of_day: "10:00" }, NOW), "2026-10-06T01:00:00.000Z"); // 来週の火曜
  assert.equal(computeNextDue({ mode: "weekly", weekday: 1, time_of_day: "10:00" }, NOW), "2026-10-05T01:00:00.000Z"); // 月曜
  assert.equal(computeNextDue({ mode: "weekly", weekday: 0, time_of_day: "09:00" }, NOW), "2026-10-04T00:00:00.000Z"); // 日曜
  // UTCでは月曜だが日本時間では火曜 00:10
  assert.equal(computeNextDue({ mode: "weekly", weekday: 2, time_of_day: "09:00" }, "2026-09-28T15:10:00Z"), "2026-09-29T00:00:00.000Z");
});

test("○時間ごとは前回の予定時刻から数え、夜間に溜まった分は1回にまとめる", () => {
  assert.equal(computeNextDue({ mode: "hourly_interval", interval_hours: 6 }, NOW), "2026-09-29T17:55:00.000Z");
  // 予定 03:00 JST（夜間）を 09:05 JST に依頼 → 次は 15:00 JST（09:00 は過ぎているので飛ばす）
  assert.equal(computeNextDue({ mode: "hourly_interval", interval_hours: 6 }, "2026-09-29T00:05:00Z", "2026-09-28T18:00:00Z"), "2026-09-29T06:00:00.000Z");
  assert.equal(computeNextDue({ mode: "hourly_interval", interval_hours: 1 }, "2026-09-29T00:05:00Z", "2026-09-29T00:00:00Z"), "2026-09-29T01:00:00.000Z");
  // 予定がまだ先ならそのまま
  assert.equal(computeNextDue({ mode: "hourly_interval", interval_hours: 3 }, NOW, "2026-09-29T13:00:00Z"), "2026-09-29T13:00:00.000Z");
  assert.throws(() => computeNextDue({ mode: "hourly_interval", interval_hours: 0 }, NOW), /間隔/);
});

test("オフ・停止中は予定なし", () => {
  assert.equal(computeNextDue({ mode: "off" }, NOW), null);
  assert.equal(computeNextDue({ mode: "daily", time_of_day: "10:00", enabled: false }, NOW), null);
  assert.throws(() => computeNextDue({ mode: "daily", time_of_day: "25:00" }, NOW), /時刻/);
  assert.throws(() => computeNextDue({ mode: "weekly", time_of_day: "10:00", weekday: 7 }, NOW), /曜日/);
});

test("管理画面の保存内容を検証し、周期に不要な項目は保存しない", () => {
  assert.deepEqual(validateScheduleInput({ source: "tabelog", storeId: "13245351", mode: "daily", timeOfDay: "9:00".padStart(5, "0"), intervalHours: 6 }),
    { source: "tabelog", store_id: "13245351", mode: "daily", enabled: true, interval_hours: null, time_of_day: "09:00", weekday: null });
  assert.deepEqual(validateScheduleInput({ source: "ikyu", storeId: "112789", mode: "weekly", timeOfDay: "10:30", weekday: 1, enabled: false }),
    { source: "ikyu", store_id: "112789", mode: "weekly", enabled: false, interval_hours: null, time_of_day: "10:30", weekday: 1 });
  assert.equal(validateScheduleInput({ source: "google", mode: "hourly_interval", intervalHours: "12" }).interval_hours, 12);
  assert.equal(validateScheduleInput({ source: "hotpepper" }).mode, "off");
  for (const bad of [{ source: "retty" }, { source: "ikyu", storeId: "" }, { source: "tabelog", storeId: "店" }, { source: "tabelog", mode: "monthly" },
    { source: "tabelog", mode: "hourly_interval", intervalHours: 0 }, { source: "tabelog", mode: "hourly_interval", intervalHours: 169 },
    { source: "tabelog", mode: "daily" }, { source: "tabelog", mode: "daily", timeOfDay: "24:00" }, { source: "tabelog", mode: "weekly", timeOfDay: "10:00" },
    { source: "tabelog", mode: "daily", timeOfDay: "10:00", enabled: "yes" }]) {
    assert.throws(() => validateScheduleInput(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(SCHEDULE_MODES, ["off", "hourly_interval", "daily", "weekly"]);
  assert.deepEqual(SUPPORTED_SCHEDULE_SOURCES, ["tabelog", "ikyu"]);
});

test("保存時の次回予定: 間隔指定は前回の依頼から数える", () => {
  const row = validateScheduleInput({ source: "tabelog", mode: "hourly_interval", intervalHours: 6 });
  assert.equal(nextDueOnSave(row, NOW), "2026-09-29T17:55:00.000Z");
  assert.equal(nextDueOnSave(row, NOW, "2026-09-29T10:00:00Z"), "2026-09-29T16:00:00.000Z");
  assert.equal(nextDueOnSave(validateScheduleInput({ source: "tabelog", mode: "off" }), NOW), null);
});

test("表示用の周期と稼働時間外の判定", () => {
  assert.equal(describeSchedule({ mode: "hourly_interval", intervalHours: 6 }), "6時間ごと");
  assert.equal(describeSchedule({ mode: "daily", timeOfDay: "10:00" }), "毎日 10:00");
  assert.equal(describeSchedule({ mode: "weekly", time_of_day: "10:00:00", weekday: 1 }), "毎週 月曜 10:00");
  assert.equal(describeSchedule({ mode: "off" }), "オフ");
  assert.equal(timeOutsideAgentWindow("08:59"), true);
  assert.equal(timeOutsideAgentWindow("09:00"), false);
  assert.equal(timeOutsideAgentWindow("22:59"), false);
  assert.equal(timeOutsideAgentWindow("23:00"), true);
  assert.equal(inAgentWindow(NOW), true);
  assert.equal(inAgentWindow("2026-09-29T14:00:00Z"), false); // 23:00 JST
  const p = publicSchedule({ id: "s1", source: "hotpepper", store_id: "", mode: "daily", time_of_day: "10:00:00", weekday: null, enabled: true, next_due_at: "x" });
  assert.equal(p.timeOfDay, "10:00"); assert.equal(p.supported, false); assert.equal(p.storeId, "");
});

// enqueue-due の偽の DB（agent_requests の未完了1件制約・件数制限を再現）
function fakeStore({ schedules, requests = [], rateLimitAfter = Infinity }) {
  const log = [];
  let inserted = 0;
  return {
    schedules, requests, log,
    listDue: async (nowIso, limit) => schedules.filter((s) => s.enabled && s.mode !== "off" && s.next_due_at && Date.parse(s.next_due_at) <= Date.parse(nowIso))
      .sort((a, b) => Date.parse(a.next_due_at) - Date.parse(b.next_due_at)).slice(0, limit).map((s) => ({ ...s })),
    listOpenRequests: async () => requests.filter((r) => ["queued", "claimed"].includes(r.status)),
    advance: async (s, patch) => {
      const row = schedules.find((x) => x.id === s.id);
      if (!row || row.next_due_at !== s.next_due_at) return false;
      Object.assign(row, patch); log.push(["advance", s.id, patch]); return true;
    },
    insertRequest: async (row) => {
      if (inserted >= rateLimitAfter) throw Object.assign(new Error("取得依頼が多すぎます"), { code: "P0429" });
      if (requests.some((r) => r.source === row.source && r.store_id === row.store_id && r.action === row.action && ["queued", "claimed"].includes(r.status))) throw Object.assign(new Error("dup"), { code: "23505" });
      inserted++;
      const saved = { ...row, id: `req-${inserted}`, status: "queued" };
      requests.push(saved); return { id: saved.id };
    },
  };
}
const sched = (id, extra) => ({ id, source: "tabelog", store_id: "1", mode: "daily", time_of_day: "10:00:00", weekday: null, interval_hours: null, enabled: true, last_enqueued_at: null, ...extra });

test("enqueue-due: 予定時刻を過ぎた設定だけを scheduled 依頼にし、次回予定を日本時間で進める", async () => {
  const store = fakeStore({ schedules: [
    sched("a", { next_due_at: "2026-09-29T01:00:00Z" }),
    sched("b", { source: "ikyu", store_id: "112789", mode: "hourly_interval", interval_hours: 6, time_of_day: null, next_due_at: "2026-09-29T06:00:00Z" }),
    sched("c", { next_due_at: "2026-09-30T01:00:00Z", store_id: "2" }), // まだ先
    sched("d", { store_id: "3", enabled: false, next_due_at: null }),
  ] });
  const res = await enqueueDueSchedules(store, { now: NOW });
  assert.deepEqual(res.enqueued.map((e) => [e.scheduleId, e.requestId, e.nextDueAt]), [
    ["a", "req-1", "2026-09-30T01:00:00.000Z"], ["b", "req-2", "2026-09-29T12:00:00.000Z"],
  ]);
  assert.deepEqual(store.requests[0], { source: "tabelog", store_id: "1", action: "sync_now", params: { trigger: "schedule", scheduleId: "a", dueAt: "2026-09-29T01:00:00Z" }, id: "req-1", status: "queued" });
  const a = store.schedules.find((s) => s.id === "a");
  assert.equal(a.last_enqueued_at, NOW); assert.equal(a.last_request_id, "req-1"); assert.equal(a.next_due_at, "2026-09-30T01:00:00.000Z");
  assert.equal(store.schedules.find((s) => s.id === "c").last_enqueued_at, null);
  // 同じ時刻に再実行しても二重に依頼しない
  const again = await enqueueDueSchedules(store, { now: NOW });
  assert.deepEqual(again.enqueued, []);
  assert.equal(store.requests.length, 2);
});

test("enqueue-due: 同じ店舗×サイトの依頼が依頼中・取得中なら依頼せず予定だけ進める", async () => {
  const store = fakeStore({
    schedules: [sched("a", { next_due_at: "2026-09-29T01:00:00Z" }), sched("b", { source: "google", store_id: "", next_due_at: "2026-09-29T01:00:00Z" })],
    requests: [{ source: "tabelog", store_id: "1", action: "fetch_reviews", status: "claimed" }, { source: "google", store_id: "", action: "sync_now", status: "done" }],
  });
  const res = await enqueueDueSchedules(store, { now: NOW });
  assert.deepEqual(res.skipped, [{ scheduleId: "a", source: "tabelog", storeId: "1", reason: "open_request", nextDueAt: "2026-09-30T01:00:00.000Z" }]);
  assert.deepEqual(res.enqueued.map((e) => e.scheduleId), ["b"]);
  const a = store.schedules.find((s) => s.id === "a");
  assert.equal(a.last_enqueued_at, null); assert.equal(a.next_due_at, "2026-09-30T01:00:00.000Z");
});

test("enqueue-due: 件数制限では予定を戻して終了し、他のエージェントが先に処理した設定は飛ばす", async () => {
  const store = fakeStore({ schedules: [sched("a", { next_due_at: "2026-09-29T01:00:00Z" }), sched("b", { store_id: "2", next_due_at: "2026-09-29T02:00:00Z" }), sched("c", { store_id: "3", next_due_at: "2026-09-29T03:00:00Z" })], rateLimitAfter: 1 });
  const res = await enqueueDueSchedules(store, { now: NOW });
  assert.deepEqual(res.enqueued.map((e) => e.scheduleId), ["a"]);
  assert.deepEqual(res.skipped, [{ scheduleId: "b", source: "tabelog", storeId: "2", reason: "rate_limited" }]);
  const b = store.schedules.find((s) => s.id === "b");
  assert.equal(b.next_due_at, "2026-09-29T02:00:00Z"); assert.equal(b.last_enqueued_at, null);
  assert.equal(store.schedules.find((s) => s.id === "c").next_due_at, "2026-09-29T03:00:00Z");

  const race = fakeStore({ schedules: [sched("a", { next_due_at: "2026-09-29T01:00:00Z" })] });
  const origList = race.listDue;
  race.listDue = async (...args) => { const rows = await origList(...args); race.schedules[0].next_due_at = "2026-09-30T01:00:00.000Z"; return rows; };
  const r2 = await enqueueDueSchedules(race, { now: NOW });
  assert.deepEqual(r2.skipped.map((s) => s.reason), ["concurrent"]);
  assert.equal(race.requests.length, 0);
});

test("enqueue-due: dryRun は何も保存しない", async () => {
  const store = fakeStore({ schedules: [sched("a", { next_due_at: "2026-09-29T01:00:00Z" })] });
  const res = await enqueueDueSchedules(store, { now: NOW, dryRun: true });
  assert.equal(res.enqueued.length, 1); assert.equal(res.enqueued[0].requestId, null);
  assert.equal(store.log.length, 0); assert.equal(store.requests.length, 0);
});

test("agent-queue --enqueue-due は /schedules/enqueue-due を呼ぶ", () => {
  assert.deepEqual(queueCommand({ _: [], "enqueue-due": true }), { path: "/schedules/enqueue-due", body: {} });
  assert.deepEqual(queueCommand({ _: [], "enqueue-due": true, limit: "10", "dry-run": true }), { path: "/schedules/enqueue-due", body: { limit: 10, dryRun: true } });
  assert.throws(() => queueCommand({ _: [], "enqueue-due": true, limit: "0" }), /limit/);
  assert.throws(() => queueCommand({ _: [], "enqueue-due": true, claim: true }));
});

test("migration 012: サイト一覧が共通モジュールと一致し、ブラウザは本人の行の閲覧のみ", () => {
  const sql = fs.readFileSync(new URL("../../supabase/migrations/012_fetch_schedules.sql", import.meta.url), "utf8");
  const listed = sql.match(/source in \(([^)]+)\)/)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...listed].sort(), [...SCHEDULE_SOURCES].sort());
  assert.match(sql, /enable row level security/);
  assert.match(sql, /for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(sql, /revoke all on public\.fetch_schedules from anon, authenticated/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)/i);
  assert.match(sql, /unique \(user_id, source, store_id\)/);
});
