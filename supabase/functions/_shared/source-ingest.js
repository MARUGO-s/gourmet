// 全サイト共通: 外部取り込み（Grok Bot → agent-api /ingest）の検証・正規化と、ダッシュボード読み込み。
// Node/Edge 共通の純粋モジュール。取り込み契約は README「外部エージェント（Grok Bot）による取り込み」。
// 一休は店舗管理画面の構成が異なるため ikyu-data.js（/ingest で source="ikyu" のとき）を使う。
import { japanDate } from "./sync-data.js";
import { SOURCE_IDS } from "./sources.js";

export const SOURCE_SCHEMA_VERSION = 1;
// 取り込み項目（キャメルケース）→ DB列。未掲載は null（実測0と区別）。
export const METRIC_COLUMNS = {
  pv: "pv", pvSp: "pv_sp", pvPc: "pv_pc", pvApp: "pv_app", pvOther: "pv_other",
  reservations: "reservations", reservationAmount: "reservation_amount", covers: "covers", visits: "visits", calls: "calls",
};
export const METRIC_KEYS = Object.keys(METRIC_COLUMNS);
export const LIMITS = { stores: 50, daysPerStore: 5000, monthsPerStore: 240, reviewsPerStore: 2000, reportsPerStore: 40, reportBytes: 200_000, extraKeys: 30 };

const fail = (message) => { throw new Error(message); };
const count = (v) => v == null || (Number.isSafeInteger(v) && v >= 0 && v <= 1e11);
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validMonth = (value) => typeof value === "string" && /^\d{4}-\d{2}$/.test(value) && validDate(`${value}-01`);
const optDate = (v) => v == null || validDate(v);
const optText = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const rating = (v) => v == null || (Number.isFinite(v) && v >= 0 && v <= 5);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
export const STORE_KEY = /^[0-9A-Za-z_-]{0,40}$/;
export const TABELOG_PUBLIC_URL = /^https:\/\/tabelog\.com\/[A-Za-z0-9/_-]+\/[0-9]{8}\/$/;
const repliedStatus = /返信済|対応済|処理済|完了/;

// 端末別の内訳: pvOther（未分類の差）を指定した場合は未指定端末を0として合計が pv と一致。
// pvOther を省略した場合は、端末別の合計が pv を超えないこと。
export function checkMetricRow(row, where) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail(`${where} の形式が不正です`);
  for (const key of METRIC_KEYS) if (!count(row[key])) fail(`${where} の数値が不正です（${key}：0以上の整数またはnull）`);
  const parts = ["pvSp", "pvPc", "pvApp", "pvOther"].map((k) => row[k]).filter((v) => v != null);
  if (row.pv != null && parts.length) {
    const sum = parts.reduce((a, b) => a + b, 0);
    if (row.pvOther != null ? sum !== row.pv : sum > row.pv) fail(`${where} の端末別PVの合計が pv と一致しません`);
  }
  if (row.extra != null) {
    if (typeof row.extra !== "object" || Array.isArray(row.extra) || Object.keys(row.extra).length > LIMITS.extraKeys) fail(`${where} の extra が不正です`);
    for (const [k, v] of Object.entries(row.extra)) if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) || !count(v)) fail(`${where} の extra.${k} が不正です（0以上の整数）`);
  }
}
const pick = (row) => ({ ...Object.fromEntries(METRIC_KEYS.map((k) => [METRIC_COLUMNS[k], row?.[k] ?? null])), extra: row?.extra ?? {} });
const sumKey = (rows, key) => (rows.length && rows.every((d) => d[key] != null) ? rows.reduce((a, d) => a + d[key], 0) : null);

function normalizeReview(r, source) {
  const id = String(r?.externalId ?? "");
  if (!/^[0-9A-Za-z._:#-]{1,200}$/.test(id)) fail("reviews.items[].externalId が不正です（英数字と ._:#- の1〜200文字）");
  if (![r.postedAt, r.visitDate, r.publishedAt, r.reply?.date].every(optDate) || (r.visitMonth != null && !validMonth(r.visitMonth))) fail(`口コミ（${id}）の日付が不正です（YYYY-MM-DD / YYYY-MM）`);
  const scores = r.scores ?? [];
  if (!Array.isArray(scores) || scores.length > 20) fail(`口コミ（${id}）の個別評価が不正です`);
  if (!rating(r.rating) || scores.some((s) => typeof s?.label !== "string" || s.label.length > 50 || !rating(s.value) || !optText(s.breakdown, 500))) fail(`口コミ（${id}）の点数が不正です（0〜5）`);
  if (typeof (r.text ?? "") !== "string" || (r.text ?? "").length > 50000 || !optText(r.title, 1000) || !optText(r.author, 300) || !optText(r.status, 100)
    || (r.reply != null && (typeof r.reply !== "object" || typeof r.reply.text !== "string" || r.reply.text.length > 50000 || !optText(r.reply.status, 100)))) fail(`口コミ（${id}）の本文・項目の形式が不正です`);
  if ((r.needsReply != null && typeof r.needsReply !== "boolean") || (r.textComplete != null && typeof r.textComplete !== "boolean")) fail(`口コミ（${id}）の needsReply / textComplete は true/false です`);
  if (r.details != null && (typeof r.details !== "object" || Array.isArray(r.details) || JSON.stringify(r.details).length > 20000)) fail(`口コミ（${id}）の details が不正です`);
  const replyText = r.reply?.text?.trim() ? r.reply.text : null;
  const { url: _ignored, ...details } = r.details ?? {};
  return {
    external_id: id, rating: round2(r.rating ?? null),
    scores: scores.map((s) => ({ label: s.label, value: round2(s.value ?? null), breakdown: s.breakdown ?? null })),
    title: r.title ?? "", text: r.text ?? "", text_complete: r.textComplete ?? true, author: r.author?.trim() || null,
    review_date: r.postedAt ?? null, visit_date: r.visitDate ?? null, visit_month: r.visitMonth ?? (r.visitDate ? r.visitDate.slice(0, 7) : null),
    published_at: r.publishedAt ?? null, status: r.status ?? null,
    reply_text: replyText, reply_date: replyText ? r.reply?.date ?? null : null, reply_status: replyText ? r.reply?.status ?? null : null,
    needs_reply: r.needsReply ?? (source === "tabelog" ? null : !(replyText || repliedStatus.test(r.status ?? ""))),
    details,
  };
}

// 取り込み本文を検証し、ingest_source(p_source, p_run, p_stores) の形へ変換する。
// 当日（日本時間・集計中）以降の日は保存しない。月の確定はサーバーが判定する。
export function normalizeSourceIngest(payload, today = japanDate()) {
  if (!payload || typeof payload !== "object") fail("取り込みデータの形式が不正です");
  if (payload.schemaVersion !== SOURCE_SCHEMA_VERSION) fail(`schemaVersion は ${SOURCE_SCHEMA_VERSION} を指定してください`);
  if (!SOURCE_IDS.includes(payload.source) || payload.source === "ikyu") fail("source が不正です（一休は ikyu 形式で送信してください）");
  if (typeof payload.runId !== "string" || !/^[0-9A-Za-z._:-]{1,100}$/.test(payload.runId)) fail("runId が不正です（英数字と ._:- の1〜100文字）");
  if (!optText(payload.agent, 100) || !optText(payload.warning, 1000)) fail("agent または warning が不正です");
  if (payload.capturedAt != null && (typeof payload.capturedAt !== "string" || !Number.isFinite(Date.parse(payload.capturedAt)))) fail("capturedAt が不正です");
  if (payload.requestId != null && !/^[0-9a-f-]{36}$/.test(String(payload.requestId))) fail("requestId が不正です");
  if (!Array.isArray(payload.stores) || !payload.stores.length || payload.stores.length > LIMITS.stores) fail(`stores は1〜${LIMITS.stores}店舗で指定してください`);
  const source = payload.source, current = today.slice(0, 7), keys = new Set();
  let skippedDays = 0, hasData = false;
  const stores = payload.stores.map((store) => {
    const key = String(store?.storeKey ?? "");
    if (!STORE_KEY.test(key) || keys.has(key)) fail("storeKey が不正または重複しています（英数字・_・-の40文字以内）");
    keys.add(key);
    const where = (s) => `店舗${key || "（既定）"}の${s}`;
    if (!optText(store.name, 200)) fail(where("店舗名が不正です"));
    // 食べログの公開店舗ページ（口コミ通知のリンク用）。店舗IDが8桁なら URL の店舗IDと一致すること
    const publicUrl = store.publicUrl ?? null;
    if (publicUrl != null && (source !== "tabelog" || typeof publicUrl !== "string" || publicUrl.length > 300 || !TABELOG_PUBLIC_URL.test(publicUrl)
      || (/^\d{8}$/.test(key) && !publicUrl.endsWith(`/${key}/`)))) fail(where("publicUrl が不正です（https://tabelog.com/…/<8桁の店舗ID>/）"));
    const summary = store.summary ?? null;
    if (summary != null) {
      if (typeof summary !== "object" || Array.isArray(summary) || !rating(summary.rating) || !count(summary.reviewCount)) fail(where("summary（rating 0〜5 / reviewCount）が不正です"));
      if (!count(summary.saveCount ?? null)) fail(where("summary.saveCount が不正です"));
      if (!optText(summary.budgetNight, 80) || !optText(summary.budgetDay, 80) || !optText(summary.station, 120)) fail(where("summary の予算・最寄駅が不正です"));
    }
    const daily = store.daily ?? [], monthly = store.monthly ?? [];
    if (!Array.isArray(daily) || daily.length > LIMITS.daysPerStore) fail(where(`daily は${LIMITS.daysPerStore}日までです`));
    if (!Array.isArray(monthly) || monthly.length > LIMITS.monthsPerStore) fail(where(`monthly は${LIMITS.monthsPerStore}か月までです`));
    const seenDays = new Set(), days = [];
    for (const d of daily) {
      if (!validDate(d?.date) || seenDays.has(d.date)) fail(where("daily[].date が不正または重複しています（YYYY-MM-DD）"));
      seenDays.add(d.date);
      checkMetricRow(d, where(`日別（${d.date}）`));
      if (d.date >= today) { skippedDays++; continue; }
      days.push(d);
    }
    const seenMonths = new Set(), months = [];
    for (const m of monthly) {
      if (!validMonth(m?.month) || seenMonths.has(m.month) || m.month > current) fail(where("monthly[].month が不正です（YYYY-MM、当月以前、重複なし）"));
      seenMonths.add(m.month);
      checkMetricRow(m, where(`月別（${m.month}）`));
      months.push({ month: m.month, complete: m.month < current, derived: false, ...pick(m) });
    }
    // 月別が無い過去月は、全日の日別がそろっていれば日別の合計を月別とする（予約件数KPI用）
    const byMonth = new Map();
    for (const d of days) byMonth.set(d.date.slice(0, 7), [...(byMonth.get(d.date.slice(0, 7)) ?? []), d]);
    for (const [month, rows] of byMonth) {
      if (seenMonths.has(month) || month >= current || rows.length !== daysInMonth(month)) continue;
      const derived = Object.fromEntries(METRIC_KEYS.map((k) => [k, sumKey(rows, k)]));
      if (METRIC_KEYS.some((k) => derived[k] != null)) months.push({ month, complete: true, derived: true, ...pick(derived), extra: {} });
    }
    const reviewBlock = store.reviews ?? null;
    const items = reviewBlock?.items ?? [];
    if (reviewBlock != null && (typeof reviewBlock !== "object" || !Array.isArray(items) || items.length > LIMITS.reviewsPerStore || !count(reviewBlock.total ?? null))) fail(where(`reviews は items 配列（${LIMITS.reviewsPerStore}件まで）と total で指定してください`));
    const seen = new Set();
    const reviews = items.map((r) => {
      const row = normalizeReview(r, source);
      if (seen.has(row.external_id)) fail(where(`口コミ ${row.external_id} が重複しています`));
      seen.add(row.external_id);
      return row;
    });
    const reportList = store.reports ?? [];
    if (!Array.isArray(reportList) || reportList.length > LIMITS.reportsPerStore) fail(where(`reports は${LIMITS.reportsPerStore}件までです`));
    const reportKeys = new Set();
    const reports = reportList.map((r) => {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(r?.kind ?? "")) || !/^[0-9A-Za-z_:-]{1,40}$/.test(String(r?.period ?? "")) || reportKeys.has(`${r.kind}/${r.period}`)) fail(where("reports[].kind / period が不正または重複しています"));
      reportKeys.add(`${r.kind}/${r.period}`);
      if (r.data == null || typeof r.data !== "object" || JSON.stringify(r.data).length > LIMITS.reportBytes) fail(where(`レポート ${r.kind} の data が不正です（${LIMITS.reportBytes}文字まで）`));
      return { kind: r.kind, period: r.period, data: r.data };
    });
    if (days.length || months.length || reviews.length || reports.length || (summary && (summary.rating != null || summary.reviewCount != null))) hasData = true;
    return {
      store_key: key, name: store.name?.trim() || null, public_url: publicUrl,
      rating: round2(summary?.rating ?? null), review_count: summary?.reviewCount ?? null,
      review_total: reviewBlock?.total ?? null, reviews_included: reviewBlock != null,
      days: days.map((d) => ({ date: d.date, ...pick(d) })), months, reviews, reports,
    };
  });
  if (!hasData) fail("保存できるデータがありません（当日より前の日別・月別・口コミ・summary のいずれかを含めてください）");
  const warning = payload.warning?.trim() || "";
  return {
    source,
    run: {
      run_key: payload.runId, agent: payload.agent ?? "", captured_at: payload.capturedAt ?? null, summary_date: today,
      request_id: payload.requestId ?? null, status: warning ? "partial" : "ok",
      message: [warning, skippedDays ? `当日以降の${skippedDays}日分は集計中のため保存しませんでした` : ""].filter(Boolean).join(" / ").slice(0, 1000),
    },
    stores, skippedDays,
  };
}

// ---------- ダッシュボード（ブラウザ用・SELECTのみ） ----------
async function all(query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query().range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// source_reviews → 共通の口コミ一覧の行。旧 reviews 表と同じ external_id を持つ場合はこちらを優先する。
export function sourceReviewRow(r, storeName) {
  return {
    id: `${r.source}:${r.store_key}:${r.external_id}`, source: r.source, rating: r.rating == null ? null : Number(r.rating),
    text: r.text ?? "", author: r.author || "匿名", sentiment: "neutral", date: r.review_date ?? r.published_at ?? null,
    external_id: r.external_id, title: r.title ?? "", visit_month: r.visit_month ?? null,
    details: {
      ...(r.details ?? {}), origin: "agent_ingest", textComplete: r.text_complete !== false, storeId: r.store_key, storeName: storeName ?? null,
      visitDate: r.visit_date ?? null, publishedAt: r.published_at ?? null, processing: r.status ?? null,
      scores: (r.scores ?? []).map((s) => ({ label: s.label, value: s.value == null ? null : Number(s.value), breakdown: s.breakdown ?? null })),
      ownerReply: r.reply_text ? { text: r.reply_text, date: r.reply_date ?? "", status: r.reply_status ?? "" } : null,
      ...(r.needs_reply == null ? {} : { needsReply: !!r.needs_reply }),
    },
  };
}

export function mergeReviews(legacy, ingested) {
  const seen = new Set(ingested.map((r) => `${r.source}\u0000${r.external_id}`));
  return [...ingested, ...legacy.filter((r) => !r.external_id || !seen.has(`${r.source}\u0000${r.external_id}`))];
}

export async function loadSourceReviews(client, targets) {
  const sources = targets.filter((s) => s !== "ikyu");
  if (!sources.length) return [];
  const [reviews, stores] = await Promise.all([
    all(() => client.from("source_reviews").select("source,store_key,external_id,rating,scores,title,text,text_complete,author,review_date,visit_date,visit_month,published_at,status,reply_text,reply_date,reply_status,needs_reply,details").in("source", sources).order("source").order("store_key").order("external_id")),
    all(() => client.from("source_stores").select("source,store_key,name").in("source", sources).order("source").order("store_key")),
  ]);
  const names = new Map(stores.map((s) => [`${s.source}/${s.store_key}`, s.name]));
  return reviews.map((r) => sourceReviewRow(r, names.get(`${r.source}/${r.store_key}`)));
}

// 取り込み済みの日別・月別（全店舗合計）とレポートを、旧 source_reports 由来の詳細へ重ねる（取り込み値を優先）。
/** @param {any} base @param {{ daily?: any[], monthly?: any[], reports?: any[] }} ingested */
export function overlayDetails(base, { daily = [], monthly = [], reports = [] }) {
  const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  const deviceDaily = { ...(base.deviceDaily ?? {}) };
  const dayAgg = new Map();
  for (const d of daily) {
    const cur = dayAgg.get(d.date) ?? { pc: null, sp: null, app: null, unclassified: null };
    dayAgg.set(d.date, { pc: add(cur.pc, d.pv_pc), sp: add(cur.sp, d.pv_sp), app: add(cur.app, d.pv_app), unclassified: add(cur.unclassified, d.pv_other) });
  }
  for (const [date, v] of dayAgg) {
    if (v.pc == null && v.sp == null && v.app == null) continue;
    const { unclassified, ...devices } = v;
    deviceDaily[date] = unclassified ? { ...devices, unclassified } : devices;
  }
  const monthAgg = new Map();
  for (const m of monthly) {
    const cur = monthAgg.get(m.month) ?? {};
    monthAgg.set(m.month, {
      month: m.month, reservations: add(cur.reservations, m.reservations), calls: add(cur.calls, m.calls),
      mapPrints: add(cur.mapPrints, m.extra?.mapPrints ?? null), pv: add(cur.pv, m.pv),
      pc: add(cur.pc, m.pv_pc), sp: add(cur.sp, m.pv_sp), app: add(cur.app, m.pv_app), unclassified: add(cur.unclassified, m.pv_other),
    });
  }
  const months = new Map((base.monthly ?? []).map((m) => [m.month, m]));
  for (const [month, m] of monthAgg) {
    const { unclassified, ...rest } = m;
    months.set(month, unclassified ? { ...rest, unclassified } : rest);
  }
  const latest = (kind) => reports.filter((r) => r.kind === kind).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.period < b.period ? 1 : -1))[0]?.data;
  return {
    ...base,
    ranking: latest("area_ranking") ?? base.ranking ?? null,
    topPages: latest("top_pages") ?? base.topPages ?? null,
    ownerReviews: latest("owner_reviews") ?? base.ownerReviews ?? null,
    pageHistory: latest("page_history") ?? base.pageHistory ?? null,
    monthly: [...months.values()].sort((a, b) => (a.month < b.month ? 1 : -1)),
    deviceDaily,
  };
}

export async function loadIngestedDetails(client, source, fromDate) {
  const cols = `store_key,${Object.values(METRIC_COLUMNS).join(",")},extra`;
  const [daily, monthly, reports] = await Promise.all([
    all(() => client.from("source_daily_metrics").select(`date,${cols}`).eq("source", source).gte("date", fromDate ?? "0000-01-01").order("date").order("store_key")),
    all(() => client.from("source_monthly_metrics").select(`month,${cols}`).eq("source", source).order("month").order("store_key")),
    all(() => client.from("agent_reports").select("store_key,kind,period,data,updated_at").eq("source", source).order("kind").order("period").order("store_key")),
  ]);
  return { daily, monthly, reports };
}

// サイトごとの最終取り込み日時（sync_log の ok/partial。旧アプリ内取得の記録も含む）
export async function loadLastUpdated(client) {
  const rows = await Promise.all(SOURCE_IDS.map((source) => client.from("sync_log").select("at").eq("source", source).in("status", ["ok", "partial"]).order("at", { ascending: false }).limit(1)
    .then(({ data, error }) => [source, error ? null : data?.[0]?.at ?? null])));
  return Object.fromEntries(rows);
}
