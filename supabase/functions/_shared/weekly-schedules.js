// 店舗ごとの週報の配信予定（weekly_delivery_schedules）。Node/Edge/ブラウザ共通の純粋モジュール。
// 画面「自動取得の設定」→「週報の配信」で曜日・時刻（日本時間）を選ぶ。アプリは保存・表示だけ。
// 予定時刻を過ぎた設定を見つけて週報を作り、M-talk の店舗Botのルームへ届けるのは Grok Bot だけ:
//   agent-api POST /weekly/due（予定を過ぎた店舗の一覧）→ /weekly/claim（作業中の印）→ 実データで週報を作成・Pages に公開・
//   /weekly/deliver（dryRun → 送信）→ /weekly/finish（delivered / skipped / deferred / failed）。
// やり直し: データ待ち（deferred）・失敗（failed）は WEEKLY_RETRY_MINUTES 後に再び予定になる（WEEKLY_MAX_ATTEMPTS 回まで。超えたら翌週へ）。
// 週報の作成日 asOf は slot_at（その週の予定時刻）の日本時間の日付（やり直しても変わらない）。
import { WEEKDAY_LABELS, computeNextDue, parseTimeOfDay } from "./fetch-schedules.js";

export const WEEKLY_SCHEDULE_DEFAULT = { weekday: 1, timeOfDay: "10:13", enabled: true, includePdf: false };
export const WEEKLY_CLAIM_MINUTES = 120; // 作業中の印の期限（週報の作成・公開・送信に十分な時間）
export const WEEKLY_RETRY_MINUTES = 30;
export const WEEKLY_MAX_ATTEMPTS = 12; // 30分ごと × 12 = 約6時間待つ（10:13 → 16:13 ごろまで）
export const WEEKLY_MAX_ROOMS = 20;
export const WEEKLY_OUTCOMES = ["delivered", "skipped", "deferred", "failed"];
export const WEEKLY_STATUS_LABELS = { delivered: "配信済み", skipped: "送らなかった", deferred: "データ待ち", failed: "失敗" };
export const WEEKLY_PAGES_PREFIX = "https://marugo-s.github.io/gourmet/weekly/";

const MIN = 60_000, JST = 9 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (message) => { throw new Error(message); };
const toMs = (v) => { if (v == null) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const ms = v instanceof Date ? v.getTime() : Date.parse(v); return Number.isFinite(ms) ? ms : null; };
const iso = (ms) => new Date(ms).toISOString();
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** 日本時間の日付（YYYY-MM-DD） */
export const japanDateOf = (value) => new Date(toMs(value) + JST).toISOString().slice(0, 10);

/** 次回の予定時刻（ISO）。停止中は null。 */
export function weeklyNextDue(row, now) {
  if (!row || row.enabled === false) return null;
  return computeNextDue({ mode: "weekly", enabled: true, weekday: row.weekday, time_of_day: row.time_of_day ?? row.timeOfDay }, new Date(toMs(now)));
}

/** 画面からの保存内容を検証 → DB行（設定列）。storeIds = 本人の店舗 UUID の一覧 */
export function validateWeeklyScheduleInput(input, storeIds = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("週報の配信設定の形式が不正です");
  const storeId = typeof input.storeId === "string" ? input.storeId.trim().toLowerCase() : "";
  if (!UUID.test(storeId)) fail("店舗を選んでください");
  if (Array.isArray(storeIds) && !storeIds.map((s) => String(s).toLowerCase()).includes(storeId)) fail("店舗が見つかりません");
  const weekday = Number(input.weekday ?? WEEKLY_SCHEDULE_DEFAULT.weekday);
  if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6) fail("曜日を選んでください");
  const minutes = parseTimeOfDay(input.timeOfDay ?? WEEKLY_SCHEDULE_DEFAULT.timeOfDay);
  if (minutes == null) fail("時刻（HH:MM、日本時間）を指定してください");
  if (input.enabled != null && typeof input.enabled !== "boolean") fail("有効・停止の指定が不正です");
  if (input.includePdf != null && typeof input.includePdf !== "boolean") fail("PDF の指定が不正です");
  let roomIds = null;
  if (input.roomIds != null) {
    if (!Array.isArray(input.roomIds) || input.roomIds.length > WEEKLY_MAX_ROOMS) fail(`ルームは${WEEKLY_MAX_ROOMS}件までです`);
    const ids = input.roomIds.map(Number);
    if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) fail("ルームの番号が不正です");
    roomIds = ids.length ? [...new Set(ids)] : null; // 空 = 口コミ通知の設定どおり
  }
  return {
    store_id: storeId, weekday, time_of_day: hhmm(minutes), enabled: input.enabled ?? true,
    room_ids: roomIds, include_pdf: input.includePdf ?? false,
  };
}

/** 保存時の予定列（曜日・時刻を変えたら作業中の印・やり直し回数は消す） */
export function weeklySchedulePatchOnSave(row, now) {
  const next = weeklyNextDue(row, now);
  return { next_due_at: next, slot_at: next, claim_id: null, claim_expires_at: null, attempts: 0 };
}

/** ルーム番号の入力（「30, 31」）→ 配列。空 → null */
export function parseRoomIds(text) {
  const parts = String(text ?? "").split(/[\s,、，]+/).filter(Boolean);
  if (!parts.length) return null;
  const ids = parts.map((p) => Number(p.replace(/^#/, "")));
  if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) fail("ルームは番号（例: 30）で入力してください");
  return [...new Set(ids)];
}

/** 表示（例: 「毎週 月曜 10:13」） */
export function describeWeeklySchedule(s) {
  const min = parseTimeOfDay(s?.timeOfDay ?? s?.time_of_day);
  const w = s?.weekday;
  if (min == null || w == null) return "未設定";
  return `毎週 ${WEEKDAY_LABELS[w]}曜 ${hhmm(min)}`;
}

/**
 * DB行 → 画面・エージェント向け
 * @param {any} r
 * @param {{ name?: string | null } | null | undefined} [store]
 */
export function publicWeeklySchedule(r, store = null) {
  const min = parseTimeOfDay(r.time_of_day);
  return {
    id: r.id, storeId: r.store_id, storeName: store?.name ?? null,
    weekday: r.weekday, timeOfDay: min == null ? null : hhmm(min), enabled: r.enabled !== false,
    roomIds: Array.isArray(r.room_ids) && r.room_ids.length ? r.room_ids.map(Number) : null,
    includePdf: r.include_pdf === true,
    nextDueAt: r.next_due_at ?? null, slotAt: r.slot_at ?? null, asOf: r.slot_at ? japanDateOf(r.slot_at) : null,
    attempts: r.attempts ?? 0, working: !!(r.claim_id && r.claim_expires_at && toMs(r.claim_expires_at) > Date.now()),
    lastStatus: r.last_status ?? null, lastReason: r.last_reason ?? null, lastAsOf: r.last_as_of ?? null,
    lastHtmlUrl: r.last_html_url ?? null, lastCardMessageIds: Array.isArray(r.last_card_message_ids) ? r.last_card_message_ids : [],
    lastFinishedAt: r.last_finished_at ?? null, lastDeliveredAt: r.last_delivered_at ?? null, updatedAt: r.updated_at ?? null,
  };
}

/** 予定時刻を過ぎて、作業中でない設定か */
export function isWeeklyDue(r, now) {
  const t = toMs(now);
  if (!r || r.enabled === false || !r.next_due_at || toMs(r.next_due_at) > t) return false;
  return !(r.claim_id && r.claim_expires_at && toMs(r.claim_expires_at) > t);
}

/** /weekly/finish の入力の検証 */
export function validateWeeklyFinish(input) {
  if (!input || typeof input !== "object") fail("入力形式が不正です");
  const { scheduleId, claimId, outcome } = input;
  if (!UUID.test(String(scheduleId ?? "")) || !UUID.test(String(claimId ?? ""))) fail("scheduleId / claimId が不正です");
  if (!WEEKLY_OUTCOMES.includes(outcome)) fail(`outcome は ${WEEKLY_OUTCOMES.join(" / ")} です`);
  const reason = input.reason == null ? null : String(input.reason).replace(/\s+/g, " ").trim().slice(0, 500) || null;
  if ((outcome === "failed" || outcome === "deferred" || outcome === "skipped") && !reason) fail("reason（理由）を書いてください");
  const htmlUrl = input.htmlUrl == null ? null : String(input.htmlUrl);
  if (htmlUrl && (!htmlUrl.startsWith(WEEKLY_PAGES_PREFIX) || htmlUrl.length > 300)) fail("htmlUrl は Pages の週報 URL です");
  const ids = input.cardMessageIds == null ? [] : input.cardMessageIds;
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) fail("cardMessageIds が不正です");
  if (outcome === "delivered" && !htmlUrl) fail("配信済みは htmlUrl（週報の URL）が必要です");
  return { scheduleId: String(scheduleId).toLowerCase(), claimId: String(claimId).toLowerCase(), outcome, reason, htmlUrl, cardMessageIds: ids };
}

/**
 * 終了の報告 → 保存する列。
 *   delivered / skipped: 翌週の予定へ進める（やり直し回数は0）
 *   deferred / failed:   WEEKLY_RETRY_MINUTES 後にもう一度（WEEKLY_MAX_ATTEMPTS 回を超えたら翌週へ進め、failed として残す）
 */
export function weeklyFinishPatch(row, finish, now) {
  const t = toMs(now);
  const asOf = row.slot_at ? japanDateOf(row.slot_at) : japanDateOf(t);
  const base = {
    claim_id: null, claim_expires_at: null, last_finished_at: iso(t), last_as_of: asOf,
    last_reason: finish.reason, ...(finish.htmlUrl ? { last_html_url: finish.htmlUrl } : {}),
  };
  const advance = () => { const next = weeklyNextDue(row, t); return { next_due_at: next, slot_at: next, attempts: 0 }; };
  if (finish.outcome === "delivered") return { ...base, ...advance(), last_status: "delivered", last_delivered_at: iso(t), last_card_message_ids: finish.cardMessageIds };
  if (finish.outcome === "skipped") return { ...base, ...advance(), last_status: "skipped" };
  const attempts = Number(row.attempts ?? 0);
  const nextSlot = weeklyNextDue(row, t);
  const retryAt = t + WEEKLY_RETRY_MINUTES * MIN;
  // やり直しが次の週の予定を越える・回数を使い切ったら翌週へ
  if (attempts >= WEEKLY_MAX_ATTEMPTS || (nextSlot && retryAt >= toMs(nextSlot))) {
    return { ...base, ...advance(), last_status: "failed", last_reason: `${finish.outcome === "deferred" ? "データがそろわないまま" : ""}やり直しの上限に達しました: ${finish.reason ?? ""}`.slice(0, 500) };
  }
  return { ...base, next_due_at: iso(retryAt), last_status: finish.outcome };
}

/** 作業中の印（claim）の列 */
export function weeklyClaimPatch(row, claimId, now) {
  const t = toMs(now);
  return { claim_id: claimId, claim_expires_at: iso(t + WEEKLY_CLAIM_MINUTES * MIN), attempts: Math.min(100, Number(row.attempts ?? 0) + 1) };
}

/** 店舗のサイト割り当て（store_sites）→ { tabelog: ["13245351"], ikyu: ["112789"] }（空の店舗コードは除く） */
export function siteKeysOf(sites, storeId) {
  const out = {};
  for (const s of sites ?? []) {
    if (String(s.store_id) !== String(storeId) || !s.site_store_key) continue;
    (out[s.source] ??= []).push(String(s.site_store_key));
  }
  return out;
}

/**
 * 予定を過ぎた設定 → エージェント向けの作業項目
 * @param {any} row
 * @param {{ name?: string | null } | null | undefined} store
 * @param {any[]} sites
 */
export function weeklyDueItem(row, store, sites) {
  return {
    scheduleId: row.id, storeId: row.store_id, storeName: store?.name ?? null,
    asOf: japanDateOf(row.slot_at ?? row.next_due_at), slotAt: row.slot_at ?? row.next_due_at, dueAt: row.next_due_at,
    attempts: row.attempts ?? 0, roomIds: Array.isArray(row.room_ids) && row.room_ids.length ? row.room_ids.map(Number) : null,
    includePdf: row.include_pdf === true, sites: siteKeysOf(sites, row.store_id),
    schedule: describeWeeklySchedule(row),
  };
}

/** supabase-js（service_role）での実装。user_id は INGEST_USER_ID に固定する。 */
export function supabaseWeeklyScheduleStore(admin, userId) {
  const check = ({ data, error }) => { if (error) throw error; return data; };
  return {
    listDue: async (nowIso) => check(await admin.from("weekly_delivery_schedules").select("*").eq("user_id", userId).eq("enabled", true)
      .lte("next_due_at", nowIso).order("next_due_at").limit(50)),
    get: async (id) => check(await admin.from("weekly_delivery_schedules").select("*").eq("user_id", userId).eq("id", id).limit(1))[0] ?? null,
    stores: async (ids) => ids.length ? check(await admin.from("stores").select("id,name").eq("user_id", userId).in("id", ids)) : [],
    sites: async (ids) => ids.length ? check(await admin.from("store_sites").select("store_id,source,site_store_key").eq("user_id", userId).in("store_id", ids)) : [],
    // next_due_at が読んだときのまま・作業中でない（または期限切れ）のときだけ印を付ける（二重に作らない）
    claim: async (row, patch, nowIso) => check(await admin.from("weekly_delivery_schedules").update(patch).eq("user_id", userId).eq("id", row.id)
      .eq("next_due_at", row.next_due_at).or(`claim_id.is.null,claim_expires_at.lt."${nowIso}"`).select("*"))[0] ?? null,
    finish: async (row, claimId, patch) => check(await admin.from("weekly_delivery_schedules").update(patch).eq("user_id", userId).eq("id", row.id)
      .eq("claim_id", claimId).select("*"))[0] ?? null,
    roomsFor: async (storeId) => {
      const r = check(await admin.from("weekly_delivery_schedules").select("room_ids").eq("user_id", userId).eq("store_id", storeId).limit(1))[0];
      return Array.isArray(r?.room_ids) && r.room_ids.length ? r.room_ids.map(Number) : null;
    },
  };
}

/** /weekly/due の本体 */
export async function listWeeklyDue(store, { now = new Date() } = {}) {
  const nowIso = iso(toMs(now));
  const rows = (await store.listDue(nowIso)).filter((r) => isWeeklyDue(r, nowIso));
  const ids = [...new Set(rows.map((r) => r.store_id))];
  const [stores, sites] = await Promise.all([store.stores(ids), store.sites(ids)]);
  const byId = new Map(stores.map((s) => [s.id, s]));
  return { now: nowIso, due: rows.map((r) => weeklyDueItem(r, byId.get(r.store_id), sites)) };
}

/** /weekly/claim の本体（claimId は呼び出し側で crypto.randomUUID()） */
export async function claimWeeklySchedule(store, scheduleId, claimId, { now = new Date() } = {}) {
  const nowIso = iso(toMs(now));
  if (!UUID.test(String(scheduleId ?? ""))) fail("scheduleId が不正です");
  const row = await store.get(String(scheduleId).toLowerCase());
  if (!row) return { status: 404, error: "週報の配信設定が見つかりません" };
  if (!isWeeklyDue(row, nowIso)) return { status: 409, error: "予定時刻前か、別の作業中です" };
  const saved = await store.claim(row, weeklyClaimPatch(row, claimId, nowIso), nowIso);
  if (!saved) return { status: 409, error: "別の作業が先に始めました" };
  const [stores, sites] = await Promise.all([store.stores([saved.store_id]), store.sites([saved.store_id])]);
  return { status: 200, body: { claimId, claimExpiresAt: saved.claim_expires_at, ...weeklyDueItem(saved, stores[0], sites) } };
}

/** /weekly/finish の本体 */
export async function finishWeeklySchedule(store, input, { now = new Date() } = {}) {
  const finish = validateWeeklyFinish(input);
  const row = await store.get(finish.scheduleId);
  if (!row) return { status: 404, error: "週報の配信設定が見つかりません" };
  if (row.claim_id !== finish.claimId) return { status: 409, error: "作業中の印（claimId）が一致しません（期限切れ・別の作業で終了済み）" };
  const saved = await store.finish(row, finish.claimId, weeklyFinishPatch(row, finish, now));
  if (!saved) return { status: 409, error: "作業中の印（claimId）が一致しません" };
  return { status: 200, body: { schedule: publicWeeklySchedule(saved) } };
}
