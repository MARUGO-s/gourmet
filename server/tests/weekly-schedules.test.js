// 週報の配信予定（weekly_delivery_schedules）: 画面で選んだ曜日・時刻が次回予定になり、Grok Bot が due → claim → finish する。
import test from "node:test";
import assert from "node:assert/strict";
import {
  WEEKLY_MAX_ATTEMPTS, WEEKLY_RETRY_MINUTES, claimWeeklySchedule, describeWeeklySchedule, finishWeeklySchedule, isWeeklyDue,
  japanDateOf, listWeeklyDue, parseRoomIds, publicWeeklySchedule, validateWeeklyFinish, validateWeeklyScheduleInput,
  weeklyClaimPatch, weeklyFinishPatch, weeklyNextDue, weeklySchedulePatchOnSave,
} from "../../supabase/functions/_shared/weekly-schedules.js";
import { weeklyRoomIds } from "../../supabase/functions/_shared/weekly-delivery.js";

const STORE = "89831708-aeac-4d1d-a345-8b345579a27f";
const NOW = "2026-10-05T01:00:00.000Z"; // 日本時間 10:00
const slot = "2026-10-05T01:13:00.000Z"; // 日本時間 10:13

test("validateWeeklyScheduleInput: weekday・time・rooms・enabled", () => {
  const row = validateWeeklyScheduleInput({ storeId: STORE, weekday: 1, timeOfDay: "10:13", roomIds: [30], enabled: true }, [STORE]);
  assert.deepEqual(row, { store_id: STORE, weekday: 1, time_of_day: "10:13", enabled: true, room_ids: [30], include_pdf: false });
  assert.equal(validateWeeklyScheduleInput({ storeId: STORE, roomIds: [] }, [STORE]).room_ids, null);
  assert.throws(() => validateWeeklyScheduleInput({ storeId: STORE }, ["other"]), /店舗が見つかりません/);
  assert.throws(() => validateWeeklyScheduleInput({ storeId: STORE, timeOfDay: "25:00" }, [STORE]), /時刻/);
  assert.deepEqual(parseRoomIds("30, 31"), [30, 31]);
  assert.deepEqual(parseRoomIds("30、31"), [30, 31]);
  assert.equal(parseRoomIds(""), null);
});

test("weeklyNextDue / describe: 日本時間の毎週月曜 10:13", () => {
  // 月曜 10:00 JST → 同日 10:13 が次
  assert.equal(weeklyNextDue({ weekday: 1, time_of_day: "10:13", enabled: true }, NOW), slot);
  // 月曜 10:20 JST → 翌週
  assert.equal(weeklyNextDue({ weekday: 1, timeOfDay: "10:13", enabled: true }, "2026-10-05T01:20:00.000Z"), "2026-10-12T01:13:00.000Z");
  assert.equal(weeklyNextDue({ weekday: 1, time_of_day: "10:13", enabled: false }, NOW), null);
  assert.equal(describeWeeklySchedule({ weekday: 1, time_of_day: "10:13" }), "毎週 月曜 10:13");
  assert.equal(japanDateOf(slot), "2026-10-05");
});

test("finish patch: delivered → 翌週、deferred → 30分後、上限で翌週へ", () => {
  const row = { weekday: 1, time_of_day: "10:13", enabled: true, next_due_at: slot, slot_at: slot, attempts: 1 };
  const ok = weeklyFinishPatch(row, { outcome: "delivered", reason: null, htmlUrl: "https://marugo-s.github.io/gourmet/weekly/x/2026-10-05/", cardMessageIds: [974] }, slot);
  assert.equal(ok.next_due_at, "2026-10-12T01:13:00.000Z");
  assert.equal(ok.attempts, 0);
  assert.equal(ok.last_status, "delivered");
  assert.deepEqual(ok.last_card_message_ids, [974]);
  const wait = weeklyFinishPatch(row, { outcome: "deferred", reason: "日別が欠けている", htmlUrl: null, cardMessageIds: [] }, slot);
  assert.equal(wait.next_due_at, new Date(Date.parse(slot) + WEEKLY_RETRY_MINUTES * 60_000).toISOString());
  assert.equal(wait.last_status, "deferred");
  const give = weeklyFinishPatch({ ...row, attempts: WEEKLY_MAX_ATTEMPTS }, { outcome: "failed", reason: "足りない", htmlUrl: null, cardMessageIds: [] }, slot);
  assert.equal(give.next_due_at, "2026-10-12T01:13:00.000Z");
  assert.match(give.last_reason, /上限/);
});

test("isWeeklyDue / claim patch: 作業中の印がある間は二重に始めない", () => {
  assert.equal(isWeeklyDue({ enabled: true, next_due_at: slot, claim_id: null }, "2026-10-05T01:14:00.000Z"), true);
  assert.equal(isWeeklyDue({ enabled: true, next_due_at: slot, claim_id: "c", claim_expires_at: "2026-10-05T03:14:00.000Z" }, "2026-10-05T01:14:00.000Z"), false);
  assert.equal(isWeeklyDue({ enabled: true, next_due_at: slot, claim_id: "c", claim_expires_at: "2026-10-05T01:10:00.000Z" }, "2026-10-05T01:14:00.000Z"), true, "期限切れは取り直せる");
  const c = weeklyClaimPatch({ attempts: 0 }, "claim-1", "2026-10-05T01:14:00.000Z");
  assert.equal(c.claim_id, "claim-1");
  assert.equal(c.attempts, 1);
});

test("listWeeklyDue / claim / finish with fake store", async () => {
  const row = {
    id: "11111111-1111-1111-1111-111111111111", user_id: "u", store_id: STORE, weekday: 1, time_of_day: "10:13", enabled: true,
    room_ids: [30], include_pdf: false, next_due_at: slot, slot_at: slot, claim_id: null, claim_expires_at: null, attempts: 0,
  };
  let current = { ...row };
  const store = {
    listDue: async () => [current],
    get: async (id) => (id === current.id ? current : null),
    stores: async () => [{ id: STORE, name: "BISTRO CAVA CAVA" }],
    sites: async () => [{ store_id: STORE, source: "tabelog", site_store_key: "13245351" }, { store_id: STORE, source: "ikyu", site_store_key: "112789" }],
    claim: async (_r, patch) => { current = { ...current, ...patch }; return current; },
    finish: async (_r, claimId, patch) => { if (current.claim_id !== claimId) return null; current = { ...current, ...patch }; return current; },
  };
  const due = await listWeeklyDue(store, { now: "2026-10-05T01:14:00.000Z" });
  assert.equal(due.due.length, 1);
  assert.equal(due.due[0].asOf, "2026-10-05");
  assert.deepEqual(due.due[0].sites, { tabelog: ["13245351"], ikyu: ["112789"] });
  assert.deepEqual(due.due[0].roomIds, [30]);
  const claimed = await claimWeeklySchedule(store, row.id, "22222222-2222-2222-2222-222222222222", { now: "2026-10-05T01:14:00.000Z" });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.claimId, "22222222-2222-2222-2222-222222222222");
  const again = await claimWeeklySchedule(store, row.id, "33333333-3333-3333-3333-333333333333", { now: "2026-10-05T01:15:00.000Z" });
  assert.equal(again.status, 409);
  const done = await finishWeeklySchedule(store, {
    scheduleId: row.id, claimId: "22222222-2222-2222-2222-222222222222", outcome: "delivered",
    htmlUrl: `https://marugo-s.github.io/gourmet/weekly/${STORE}/2026-10-05/`, cardMessageIds: [974],
  }, { now: "2026-10-05T01:20:00.000Z" });
  assert.equal(done.status, 200);
  assert.equal(done.body.schedule.lastStatus, "delivered");
  assert.equal(done.body.schedule.nextDueAt, "2026-10-12T01:13:00.000Z");
  assert.throws(() => validateWeeklyFinish({ scheduleId: row.id, claimId: "x", outcome: "delivered" }), /claimId/);
});

test("weeklyRoomIds: --room → 画面の週報ルーム → 口コミ通知のルーム → 店舗ルーム", () => {
  const bot = { id: "b" }, bots = [{ id: "b", rooms: [{ id: 5, isStoreRoom: false }, { id: 30, isStoreRoom: true }] }];
  assert.deepEqual(weeklyRoomIds({ requested: [99], scheduled: [30], settings: { roomIds: [7] }, bot, bots }), [99]);
  assert.deepEqual(weeklyRoomIds({ scheduled: [30], settings: { roomIds: [7] }, bot, bots }), [30]);
  assert.deepEqual(weeklyRoomIds({ settings: { roomIds: [7] }, bot, bots }), [7]);
  assert.deepEqual(weeklyRoomIds({ settings: { roomIds: null }, bot, bots }), [30]);
});

test("publicWeeklySchedule / save patch", () => {
  const row = { ...validateWeeklyScheduleInput({ storeId: STORE, weekday: 1, timeOfDay: "10:13", roomIds: [30] }, [STORE]), id: "i", next_due_at: slot, slot_at: slot, attempts: 0 };
  const patch = weeklySchedulePatchOnSave(row, NOW);
  assert.equal(patch.next_due_at, slot);
  assert.equal(patch.claim_id, null);
  const pub = publicWeeklySchedule({ ...row, ...patch, last_status: null, last_card_message_ids: [] }, { name: "BISTRO CAVA CAVA" });
  assert.equal(pub.storeName, "BISTRO CAVA CAVA");
  assert.equal(pub.asOf, "2026-10-05");
  assert.deepEqual(pub.roomIds, [30]);
});
