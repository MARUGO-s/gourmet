// AI分析（ai-analyst）のデータ読み込み。本人のJWTのクライアントで呼ぶ（RLS・SELECTのみ）。
// 集計は ai-analyst.js（純粋関数・テストあり）。ダッシュボード（review-api）と同じ表・同じ合成規則を使う。
import { SOURCE_IDS } from "./sources.js";
import { japanDate } from "./sync-data.js";
import { loadOverviewInputs, loadStoreDailyInputs, loadStoreMaster } from "./store-data.js";
import { loadSourceReviews, mergeReviews } from "./source-ingest.js";
import { dropPublicDuplicates, loadIkyuReviews } from "./ikyu-data.js";
import { loadFreshness } from "./data-freshness.js";
import { shiftDate } from "./ai-analyst.js";

async function all(query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query().range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}
const num = (v) => (v == null ? null : Number(v));

/** @param {any} client @param {{ today?: string }} [options] */
export async function loadAnalystDataset(client, { today = japanDate() } = {}) {
  const [master, daily, overview, legacy, legacyReviews, ingested, owner] = await Promise.all([
    loadStoreMaster(client),
    loadStoreDailyInputs(client, SOURCE_IDS),
    loadOverviewInputs(client, { today }),
    all(() => client.from("snapshots").select("source,date,rating,reviews,pv,reservations").neq("source", "ikyu").order("id")),
    all(() => client.from("reviews").select("id,source,rating,text,author,review_date,external_id,title,visit_month,details").order("id")),
    loadSourceReviews(client, SOURCE_IDS).catch(() => []),
    loadIkyuReviews(client).catch(() => []),
  ]);
  const cached = await loadCachedDetails(client, { today });
  let reviews = mergeReviews(legacyReviews.map((r) => ({ ...r, rating: num(r.rating), date: r.review_date ?? null, details: r.details ?? {} })), ingested);
  reviews = [...dropPublicDuplicates(reviews, owner), ...owner];
  return {
    today,
    stores: master.stores, sites: master.sites,
    daily: daily.daily,
    legacy: legacy.map((s) => ({ source: s.source, date: String(s.date).slice(0, 10), pv: num(s.pv), rating: num(s.rating), reviews: num(s.reviews), reservations: num(s.reservations) })),
    monthly: overview.monthly, current: overview.current,
    reviews: reviews.map((r) => ({ ...r, date: r.date ? String(r.date).slice(0, 10) : null })),
    ...cached,
  };
}

// 毎日の取り込み（管理画面の確定値）の詳細: 一休の予約（受付日ベースの件数・金額）・ページ種別×端末のPV、食べログの端末別PV・来店指標、
// 食べログの詳細レポート（エリア順位・よく見られるページ・端末別ページサマリー）、サイトごとの鮮度。読めない表は空（答えは止めない）。
const CACHED_REPORT_KINDS = ["area_ranking", "top_pages", "device_summary"];
/** @param {any} client @param {{ today: string }} options */
export async function loadCachedDetails(client, { today }) {
  const since = shiftDate(today, -731);
  const safe = (p) => p.catch(() => []);
  const [ikyuDaily, ikyuMonthly, sourceDaily, sourceMonthly, reports, freshness] = await Promise.all([
    safe(all(() => client.from("ikyu_daily_pageviews").select("store_id,date,guide_sp,guide_pc,guide_total,plan_sp,plan_pc,plan_total,other_sp,other_pc,other_total,sp,pc,pv,reservations,reservation_amount").gte("date", since).order("date").order("store_id"))),
    safe(all(() => client.from("ikyu_monthly_pageviews").select("store_id,month,complete,days,reservations,reservation_amount,pv,sp,pc").order("month").order("store_id"))),
    safe(all(() => client.from("source_daily_metrics").select("source,store_key,date,pv,pv_sp,pv_pc,pv_app,pv_other,reservations,calls").gte("date", since).order("date").order("source").order("store_key"))),
    safe(all(() => client.from("source_monthly_metrics").select("source,store_key,month,complete,derived,pv,pv_sp,pv_pc,pv_app,pv_other,reservations,calls,extra").order("month").order("source").order("store_key"))),
    safe(all(() => client.from("agent_reports").select("source,store_key,kind,period,data,updated_at").in("kind", CACHED_REPORT_KINDS).order("updated_at", { ascending: false }))),
    loadFreshness(client).catch(() => []),
  ]);
  const ikyuRow = (r) => ({ key: r.store_id, guideSp: num(r.guide_sp), guidePc: num(r.guide_pc), guide: num(r.guide_total), planSp: num(r.plan_sp), planPc: num(r.plan_pc), plan: num(r.plan_total),
    otherSp: num(r.other_sp), otherPc: num(r.other_pc), other: num(r.other_total), sp: num(r.sp), pc: num(r.pc), pv: num(r.pv), reservations: num(r.reservations), amount: num(r.reservation_amount) });
  return {
    ikyuDaily: ikyuDaily.map((r) => ({ date: String(r.date).slice(0, 10), ...ikyuRow(r) })),
    ikyuMonthly: ikyuMonthly.map((r) => ({ key: r.store_id, month: r.month, complete: r.complete === true, days: num(r.days), pv: num(r.pv), sp: num(r.sp), pc: num(r.pc), reservations: num(r.reservations), amount: num(r.reservation_amount) })),
    sourceDaily: sourceDaily.map((r) => ({ source: r.source, key: r.store_key ?? "", date: String(r.date).slice(0, 10), pv: num(r.pv), pvSp: num(r.pv_sp), pvPc: num(r.pv_pc), pvApp: num(r.pv_app), pvOther: num(r.pv_other), reservations: num(r.reservations), calls: num(r.calls) })),
    sourceMonthly: sourceMonthly.map((r) => ({ source: r.source, key: r.store_key ?? "", month: r.month, complete: r.complete === true, derived: r.derived === true, pv: num(r.pv), pvSp: num(r.pv_sp), pvPc: num(r.pv_pc), pvApp: num(r.pv_app), pvOther: num(r.pv_other),
      reservations: num(r.reservations), calls: num(r.calls), mapPrints: num(r.extra?.mapPrints) })),
    reports: reports.map((r) => ({ source: r.source, key: r.store_key ?? "", kind: r.kind, period: r.period, data: r.data, updatedAt: r.updated_at })),
    freshness,
  };
}
