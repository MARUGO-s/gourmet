// 店舗×サイトごとの自動取得の設定（fetch_schedules）。Node/Edge/ブラウザ共通の純粋モジュール。
// 時刻はすべて日本時間（Asia/Tokyo、UTC+9・夏時間なし）で解釈する。
// アプリは設定の保存・表示だけを行い、予定時刻を過ぎた設定を取得依頼（agent_requests）へ変えるのは
// agent-api POST /schedules/enqueue-due（Grok Bot が呼ぶ）だけ。

export const SCHEDULE_SOURCES = ["tabelog", "ikyu", "hotpepper", "toreta", "google"];
// Grok Bot の読み取りが実装済みのサイト（他は「準備中」。設定の保存はできる）
export const SUPPORTED_SCHEDULE_SOURCES = ["tabelog", "ikyu"];
export const SCHEDULE_MODES = ["off", "hourly_interval", "daily", "weekly"];
export const MODE_LABELS = { off: "オフ", hourly_interval: "○時間ごと", daily: "毎日○時", weekly: "毎週○曜○時" };
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
export const INTERVAL_CHOICES = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];
export const MAX_INTERVAL_HOURS = 168;
// Grok Bot の稼働時間（日本時間 9:00〜22:59）。この外の予定時刻は次の稼働開始時に取得依頼になる。
export const AGENT_WINDOW = { startHour: 9, endHour: 23 };
export const AGENT_WINDOW_NOTE = "Grok Botは日本時間 9:00〜22:59 に約5分ごとに確認します。この時間外の予定は、次の稼働開始（9:00）以降にまとめて取得されます。";
// 1回の enqueue-due で処理する設定の上限（agent_requests の件数制限: 1時間30件・未完了20件）
export const ENQUEUE_LIMIT = 20;

const HOUR = 3_600_000, DAY = 24 * HOUR, JST = 9 * HOUR;
const fail = (message) => { throw new Error(message); };

// "09:00" / "09:00:00" → 分（0〜1439）。不正なら null
export function parseTimeOfDay(value) {
  const m = typeof value === "string" ? value.match(/^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const formatMinutes = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMs = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

// 日本時間の時（0〜23）
export const japanHour = (now) => new Date(toMs(now) + JST).getUTCHours();
// Grok Bot の稼働時間内か（日本時間 9:00〜22:59）
export const inAgentWindow = (now) => { const h = japanHour(now); return h >= AGENT_WINDOW.startHour && h < AGENT_WINDOW.endHour; };

// 指定時刻（日本時間）が Grok Bot の稼働時間外か（毎日・毎週の設定の注意表示用）
export function timeOutsideAgentWindow(timeOfDay) {
  const min = parseTimeOfDay(timeOfDay);
  return min != null && (min < AGENT_WINDOW.startHour * 60 || min >= AGENT_WINDOW.endHour * 60);
}

// 次回予定（ISO文字列）。オフ・停止中は null。
//   hourly_interval: anchor（前回の予定時刻）から interval_hours ごとの、now より後で最初の時刻。
//                    anchor が無ければ now + interval_hours。
//   daily:  日本時間の time_of_day で、now より後で最初の時刻
//   weekly: 日本時間の weekday・time_of_day で、now より後で最初の時刻
export function computeNextDue(schedule, now, anchor = null) {
  const nowMs = toMs(now);
  if (nowMs == null) fail("現在時刻が不正です");
  if (!schedule || schedule.enabled === false || schedule.mode === "off") return null;
  if (schedule.mode === "hourly_interval") {
    const hours = schedule.interval_hours;
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_INTERVAL_HOURS) fail("間隔（時間）が不正です");
    const step = hours * HOUR, base = toMs(anchor);
    if (base == null || base > nowMs + step) return new Date(nowMs + step).toISOString();
    if (base > nowMs) return new Date(base).toISOString();
    return new Date(base + (Math.floor((nowMs - base) / step) + 1) * step).toISOString();
  }
  const minutes = parseTimeOfDay(schedule.time_of_day);
  if (minutes == null) fail("時刻が不正です");
  // 日本時間の当日0時（UTCのミリ秒）
  const dayStart = Math.floor((nowMs + JST) / DAY) * DAY - JST;
  if (schedule.mode === "daily") {
    let t = dayStart + minutes * 60_000;
    if (t <= nowMs) t += DAY;
    return new Date(t).toISOString();
  }
  if (schedule.mode === "weekly") {
    const weekday = schedule.weekday;
    if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6) fail("曜日が不正です");
    const today = new Date(dayStart + JST).getUTCDay();
    let t = dayStart + ((weekday - today + 7) % 7) * DAY + minutes * 60_000;
    if (t <= nowMs) t += 7 * DAY;
    return new Date(t).toISOString();
  }
  fail("周期が不正です");
}

// 管理画面からの保存内容を検証 → DB行（fetch_schedules の設定列）
export function validateScheduleInput(input) {
  const source = input?.source, mode = input?.mode ?? "off";
  const storeId = typeof input?.storeId === "string" ? input.storeId.trim() : "";
  if (!SCHEDULE_SOURCES.includes(source)) fail("サイトが不正です");
  if (!SCHEDULE_MODES.includes(mode)) fail("周期が不正です");
  if (!/^[0-9A-Za-z_-]{0,40}$/.test(storeId) || (source === "ikyu" && !/^\d{6}$/.test(storeId))) fail(source === "ikyu" ? "一休は店舗ID（6桁）を指定してください" : "店舗コードが不正です");
  if (input?.enabled != null && typeof input.enabled !== "boolean") fail("有効・停止の指定が不正です");
  const row = { source, store_id: storeId, mode, enabled: input?.enabled ?? true, interval_hours: null, time_of_day: null, weekday: null };
  if (mode === "hourly_interval") {
    const hours = Number(input?.intervalHours);
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_INTERVAL_HOURS) fail(`間隔は1〜${MAX_INTERVAL_HOURS}時間で指定してください`);
    row.interval_hours = hours;
  }
  if (mode === "daily" || mode === "weekly") {
    const minutes = parseTimeOfDay(input?.timeOfDay);
    if (minutes == null) fail("時刻（HH:MM）を指定してください");
    row.time_of_day = formatMinutes(minutes);
  }
  if (mode === "weekly") {
    const weekday = Number(input?.weekday);
    if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6) fail("曜日を指定してください");
    row.weekday = weekday;
  }
  return row;
}

// 保存時の次回予定。間隔指定は前回の依頼から数える（未実行なら保存から数える）。
export function nextDueOnSave(row, now, lastEnqueuedAt = null) {
  return computeNextDue(row, now, row.mode === "hourly_interval" && lastEnqueuedAt ? lastEnqueuedAt : null);
}

// 周期の表示（例: 「6時間ごと」「毎日 10:00」「毎週 月曜 10:00」）
export function describeSchedule(s) {
  const mode = s?.mode ?? "off";
  const time = parseTimeOfDay(s?.timeOfDay ?? s?.time_of_day);
  const hours = s?.intervalHours ?? s?.interval_hours, weekday = s?.weekday;
  if (mode === "hourly_interval") return `${hours}時間ごと`;
  if (mode === "daily" && time != null) return `毎日 ${formatMinutes(time)}`;
  if (mode === "weekly" && time != null && weekday != null) return `毎週 ${WEEKDAY_LABELS[weekday]}曜 ${formatMinutes(time)}`;
  return "オフ";
}

// DB行 → 画面・エージェント向け（キャメルケース）
export function publicSchedule(r) {
  const time = parseTimeOfDay(r.time_of_day);
  return {
    id: r.id, source: r.source, storeId: r.store_id, mode: r.mode, intervalHours: r.interval_hours ?? null,
    timeOfDay: time == null ? null : formatMinutes(time), weekday: r.weekday ?? null, enabled: r.enabled !== false,
    supported: SUPPORTED_SCHEDULE_SOURCES.includes(r.source),
    lastEnqueuedAt: r.last_enqueued_at ?? null, lastRequestId: r.last_request_id ?? null, nextDueAt: r.next_due_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// 予定時刻を過ぎた設定を取得依頼にする（agent-api POST /schedules/enqueue-due の本体）。
// store は DB操作の差し替え口（本番は supabaseScheduleStore、テストは偽物）:
//   listDue(nowIso, limit)            → 有効・周期ありで next_due_at <= now の設定（古い順）
//   listOpenRequests()                → 依頼中・取得中の agent_requests（source, store_id）
//   advance(schedule, patch)          → next_due_at が schedule.next_due_at のままなら patch を保存し true（他のエージェントと二重に依頼しない）
//   insertRequest(row)                → agent_requests へ登録し { id } を返す。エラーは { code } 付きで throw
// 同じ店舗×サイトの依頼が依頼中・取得中なら新たに依頼せず、次回予定だけ進める（reason: "open_request"）。
// 件数制限（P0429）に達したら予定を戻して終了する（次の確認で再度依頼）。
export async function enqueueDueSchedules(store, { now = new Date(), limit = ENQUEUE_LIMIT, dryRun = false } = {}) {
  const nowIso = new Date(toMs(now)).toISOString();
  const due = await store.listDue(nowIso, limit);
  const open = new Set((await store.listOpenRequests()).map((r) => `${r.source}/${r.store_id}`));
  const enqueued = [], skipped = [];
  for (const s of due) {
    const key = `${s.source}/${s.store_id}`, item = { scheduleId: s.id, source: s.source, storeId: s.store_id };
    let nextDueAt;
    try { nextDueAt = computeNextDue(s, nowIso, s.next_due_at); }
    catch (error) { skipped.push({ ...item, reason: "invalid", error: error.message }); continue; }
    if (open.has(key)) {
      if (!dryRun && !await store.advance(s, { next_due_at: nextDueAt })) { skipped.push({ ...item, reason: "concurrent" }); continue; }
      skipped.push({ ...item, reason: "open_request", nextDueAt });
      continue;
    }
    if (dryRun) { enqueued.push({ ...item, requestId: null, dueAt: s.next_due_at, nextDueAt }); open.add(key); continue; }
    if (!await store.advance(s, { next_due_at: nextDueAt, last_enqueued_at: nowIso })) { skipped.push({ ...item, reason: "concurrent" }); continue; }
    const restore = { ...s, next_due_at: nextDueAt };
    try {
      const request = await store.insertRequest({
        source: s.source, store_id: s.store_id, action: "sync_now",
        params: { trigger: "schedule", scheduleId: s.id, dueAt: s.next_due_at },
      });
      await store.advance(restore, { last_request_id: request.id });
      enqueued.push({ ...item, requestId: request.id, dueAt: s.next_due_at, nextDueAt });
      open.add(key);
    } catch (error) {
      if (error?.code === "23505") { skipped.push({ ...item, reason: "open_request", nextDueAt }); open.add(key); continue; }
      // 依頼できなかったので予定を戻す（次の確認で再度依頼する）
      await store.advance(restore, { next_due_at: s.next_due_at, last_enqueued_at: s.last_enqueued_at ?? null });
      if (error?.code === "P0429") { skipped.push({ ...item, reason: "rate_limited" }); break; }
      throw error;
    }
  }
  return { now: nowIso, dryRun, enqueued, skipped };
}

// supabase-js（service_role）での store 実装。user_id は INGEST_USER_ID に固定する。
export function supabaseScheduleStore(admin, userId) {
  const check = ({ data, error }) => { if (error) throw error; return data; };
  return {
    listDue: async (nowIso, limit) => check(await admin.from("fetch_schedules").select("*").eq("user_id", userId).eq("enabled", true)
      .neq("mode", "off").lte("next_due_at", nowIso).order("next_due_at").limit(limit)),
    listOpenRequests: async () => check(await admin.from("agent_requests").select("source,store_id").eq("user_id", userId).in("status", ["queued", "claimed"]).limit(1000)),
    advance: async (s, patch) => {
      let q = admin.from("fetch_schedules").update(patch).eq("user_id", userId).eq("id", s.id);
      q = s.next_due_at == null ? q.is("next_due_at", null) : q.eq("next_due_at", s.next_due_at);
      return check(await q.select("id")).length === 1;
    },
    insertRequest: async (row) => check(await admin.from("agent_requests").insert({ ...row, user_id: userId }).select("id").single()),
  };
}
