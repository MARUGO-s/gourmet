// 店舗単位の表示（店舗の選択・全店舗の比較）のための読み込み。ブラウザ用 API（review-api）から本人のJWTで呼ぶ（RLS・SELECTのみ）。
// 集計そのものは stores.js（純粋関数・テストあり）。
import { japanDate } from "./sync-data.js";
import { STORE_SOURCES, previousMonth } from "./stores.js";

async function all(query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query().range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}
const one = (q) => q.then(({ data, error }) => { if (error) throw error; return data; });
const num = (v) => (v == null ? null : Number(v));
const jstDate = (iso) => (iso ? japanDate(new Date(iso)) : null);

export async function loadStoreMaster(client) {
  const [stores, sites] = await Promise.all([
    all(() => client.from("stores").select("id,name,sort_order,updated_at").order("sort_order").order("id")),
    all(() => client.from("store_sites").select("id,store_id,source,site_store_key").order("source").order("site_store_key")),
  ]);
  return { stores, sites };
}

// 店舗単位のダッシュボード: 店舗コードのある日別・月別の行（storeSnapshots の入力）
export async function loadStoreDailyInputs(client, targets) {
  const sources = targets.filter((s) => s !== "ikyu");
  const ikyu = targets.includes("ikyu");
  const [daily, monthly, ikyuDaily, ikyuMonthly, ikyuStores] = await Promise.all([
    sources.length ? all(() => client.from("source_daily_metrics").select("source,store_key,date,pv,rating,review_count").in("source", sources).order("source").order("store_key").order("date")) : [],
    sources.length ? all(() => client.from("source_monthly_metrics").select("source,store_key,month,reservations").in("source", sources).order("source").order("store_key").order("month")) : [],
    ikyu ? all(() => client.from("ikyu_daily_pageviews").select("store_id,date,pv").order("store_id").order("date")) : [],
    ikyu ? all(() => client.from("ikyu_monthly_pageviews").select("store_id,month,reservations").order("store_id").order("month")) : [],
    ikyu ? all(() => client.from("ikyu_stores").select("store_id,public_rating,public_review_count,public_updated_at").order("store_id")) : [],
  ]);
  return {
    daily: [
      ...daily.map((d) => ({ source: d.source, key: d.store_key, date: String(d.date), pv: num(d.pv), rating: num(d.rating), reviews: num(d.review_count) })),
      ...ikyuDaily.map((d) => ({ source: "ikyu", key: d.store_id, date: String(d.date), pv: num(d.pv) })),
      // 一休の公開評価は店舗ごとの最新値だけ（取り込んだ日の値として扱う）
      ...ikyuStores.filter((s) => s.public_updated_at && (s.public_rating != null || s.public_review_count != null))
        .map((s) => ({ source: "ikyu", key: s.store_id, date: jstDate(s.public_updated_at), rating: num(s.public_rating), reviews: num(s.public_review_count) })),
    ],
    monthly: [
      ...monthly.map((m) => ({ source: m.source, key: m.store_key, month: m.month, reservations: num(m.reservations) })),
      ...ikyuMonthly.map((m) => ({ source: "ikyu", key: m.store_id, month: m.month, reservations: num(m.reservations) })),
    ],
  };
}

// 全店舗の比較: 月別PV・予約（取り込み＋旧 source_reports の月別）、店舗コードごとの最新の評価・口コミ数・未返信・最終更新
/** @param {any} client @param {{ requestedMonth?: string|null, today?: string }} [options] */
export async function loadOverviewInputs(client, { requestedMonth = null, today = japanDate() } = {}) {
  const current = today.slice(0, 7);
  let from = current;
  for (let i = 0; i < 24; i++) from = previousMonth(from);
  if (requestedMonth && previousMonth(requestedMonth) < from) from = previousMonth(requestedMonth);
  const nonIkyu = STORE_SOURCES.filter((s) => s !== "ikyu");
  const [monthly, ikyuMonthly, legacyMonthly, sourceStores, ikyuStores, sourceUnreplied, ikyuUnreplied, creds, logs] = await Promise.all([
    all(() => client.from("source_monthly_metrics").select("source,store_key,month,pv,reservations").gte("month", from).order("source").order("store_key").order("month")),
    all(() => client.from("ikyu_monthly_pageviews").select("store_id,month,pv,reservations").gte("month", from).order("store_id").order("month")),
    all(() => client.from("source_reports").select("source,period,data").eq("kind", "monthly_metrics").gte("period", from).order("source").order("period")).catch(() => []),
    all(() => client.from("source_stores").select("source,store_key,name,rating,review_count,review_total,updated_at").order("source").order("store_key")),
    all(() => client.from("ikyu_stores").select("store_id,name,public_rating,public_review_count,review_total,updated_at").order("store_id")),
    all(() => client.from("source_reviews").select("source,store_key").eq("needs_reply", true).order("source").order("store_key").order("external_id")),
    all(() => client.from("ikyu_reviews").select("store_id").eq("needs_reply", true).order("store_id").order("reservation_no")),
    all(() => client.from("credentials").select("source,store_key").order("source").order("store_key")),
    Promise.all(STORE_SOURCES.map((source) => client.from("sync_log").select("at").eq("source", source).in("status", ["ok", "partial"]).order("at", { ascending: false }).limit(1)
      .then(({ data, error }) => [source, error ? null : data?.[0]?.at ?? null]))).then(Object.fromEntries),
  ]);
  const rows = [
    ...monthly.map((m) => ({ source: m.source, key: m.store_key, month: m.month, pv: num(m.pv), reservations: num(m.reservations) })),
    ...ikyuMonthly.map((m) => ({ source: "ikyu", key: m.store_id, month: m.month, pv: num(m.pv), reservations: num(m.reservations) })),
  ];
  // 旧データの月別（店舗コードなし＝''）。取り込みの '' の同じ月があればそちらを使う。
  const ingested = new Set(rows.map((r) => `${r.source}|${r.key}|${r.month}`));
  for (const r of legacyMonthly) {
    if (!nonIkyu.includes(r.source) || ingested.has(`${r.source}||${r.period}`)) continue;
    rows.push({ source: r.source, key: "", month: r.period, pv: num(r.data?.pv), reservations: num(r.data?.reservations) });
  }
  const unreplied = new Map();
  for (const r of sourceUnreplied) unreplied.set(`${r.source}|${r.store_key}`, (unreplied.get(`${r.source}|${r.store_key}`) ?? 0) + 1);
  for (const r of ikyuUnreplied) unreplied.set(`ikyu|${r.store_id}`, (unreplied.get(`ikyu|${r.store_id}`) ?? 0) + 1);
  const currentRows = [
    ...sourceStores.map((s) => ({ source: s.source, key: s.store_key, name: s.name, rating: num(s.rating), reviewCount: num(s.review_count ?? s.review_total),
      unreplied: unreplied.get(`${s.source}|${s.store_key}`) ?? 0, updatedAt: s.updated_at })),
    ...ikyuStores.map((s) => ({ source: "ikyu", key: s.store_id, name: s.name, rating: num(s.public_rating), reviewCount: num(s.public_review_count ?? s.review_total),
      unreplied: unreplied.get(`ikyu|${s.store_id}`) ?? 0, updatedAt: s.updated_at })),
  ];
  // 取り込み（source_stores）の無いサイトは、旧データ（snapshots）の最新の評価・口コミ数を既定の店舗コード '' の値とする
  const withStores = new Set(sourceStores.map((s) => s.source));
  const legacySources = nonIkyu.filter((s) => !withStores.has(s));
  const legacy = await Promise.all(legacySources.map(async (source) => {
    const [rating, reviews] = await Promise.all([
      one(client.from("snapshots").select("date,rating").eq("source", source).not("rating", "is", null).order("date", { ascending: false }).limit(1)),
      one(client.from("snapshots").select("date,reviews").eq("source", source).not("reviews", "is", null).order("date", { ascending: false }).limit(1)),
    ]).catch(() => [[], []]);
    if (!rating.length && !reviews.length && !rows.some((r) => r.source === source && r.key === "")) return null;
    return { source, key: "", name: null, rating: num(rating[0]?.rating), reviewCount: num(reviews[0]?.reviews), unreplied: null, updatedAt: logs[source] ?? null };
  }));
  currentRows.push(...legacy.filter(Boolean));
  const observed = creds.map((c) => ({ source: c.source, key: c.store_key }));
  return { monthly: rows, current: currentRows, observed, currentMonth: current };
}
