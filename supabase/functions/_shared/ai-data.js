// AI分析（ai-analyst）のデータ読み込み。本人のJWTのクライアントで呼ぶ（RLS・SELECTのみ）。
// 集計は ai-analyst.js（純粋関数・テストあり）。ダッシュボード（review-api）と同じ表・同じ合成規則を使う。
import { SOURCE_IDS } from "./sources.js";
import { japanDate } from "./sync-data.js";
import { loadOverviewInputs, loadStoreDailyInputs, loadStoreMaster } from "./store-data.js";
import { loadSourceReviews, mergeReviews } from "./source-ingest.js";
import { dropPublicDuplicates, loadIkyuReviews } from "./ikyu-data.js";

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
  let reviews = mergeReviews(legacyReviews.map((r) => ({ ...r, rating: num(r.rating), date: r.review_date ?? null, details: r.details ?? {} })), ingested);
  reviews = [...dropPublicDuplicates(reviews, owner), ...owner];
  return {
    today,
    stores: master.stores, sites: master.sites,
    daily: daily.daily,
    legacy: legacy.map((s) => ({ source: s.source, date: String(s.date).slice(0, 10), pv: num(s.pv), rating: num(s.rating), reviews: num(s.reviews), reservations: num(s.reservations) })),
    monthly: overview.monthly, current: overview.current,
    reviews: reviews.map((r) => ({ ...r, date: r.date ? String(r.date).slice(0, 10) : null })),
  };
}
