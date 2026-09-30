// 合成データ（実データではない）: BISTRO CAVACAVA 風のAI分析レポート。M-talk 送信（カード・PDF）のテストと見本出力に使う。
import { composeReportMarkdown } from "../../../supabase/functions/_shared/ai-analyst.js";

const month = (m, pv, res, tab, ikyu) => ({ month: m, pv, reservations: res, bySource: { tabelog: { pv: tab }, ikyu: { pv: ikyu } } });
export const sampleFacts = {
  store: { id: "11111111-1111-4111-8111-111111111111", name: "BISTRO CAVACAVA" },
  sources: ["tabelog", "ikyu"],
  period: { from: "2026-07-01", to: "2026-09-29", days: 91 },
  previousPeriod: { from: "2026-04-01", to: "2026-06-30" },
  kpis: {
    period: { from: "2026-07-01", to: "2026-09-29", days: 91 }, previousPeriod: { from: "2026-04-01", to: "2026-06-30" },
    total: { pv: 48210, prevPv: 41876, pvChangePct: 15.13, reservations: 312, newReviews: 46, unreplied: 7, currentRating: 3.61 },
    bySource: {
      tabelog: { pv: 39880, prevPv: 35120, pvChangePct: 13.55, dailyAveragePv: 438.24, reservations: 188, newReviews: 31, averageRatingInPeriod: 3.58, currentRating: 3.52, reviewCount: 412, unreplied: 5 },
      ikyu: { pv: 8330, prevPv: 6756, pvChangePct: 23.3, dailyAveragePv: 91.54, reservations: 124, newReviews: 15, averageRatingInPeriod: 4.41, currentRating: 4.5, reviewCount: 138, unreplied: 2 },
    },
  },
  monthly: [
    month("2026-04", 13210, 92, 11050, 2160), month("2026-05", 14380, 98, 12010, 2370), month("2026-06", 14286, 101, 12060, 2226),
    month("2026-07", 15102, 97, 12611, 2491), month("2026-08", 16840, 109, 13922, 2918), month("2026-09", 16268, 106, 13347, 2921),
  ],
  trend: [],
  reviewStats: { count: 46, averageRating: 3.87, distribution: { 5: 17, 4: 14, 3: 9, 2: 4, 1: 2 }, replied: 36, unreplied: 7, unknown: 3, bySource: {} },
  unreplied: [
    { date: "2026-09-27", site: "食べログ", rating: 2, text: "料理は美味しいが、ワインの提供が遅く、追加注文まで20分待った。週末の夜は人手が足りていない印象。" },
    { date: "2026-09-21", site: "一休", rating: 5, text: "記念日で利用。デザートプレートのメッセージが嬉しかったです。スタッフの方の説明も丁寧でした。" },
    { date: "2026-09-14", site: "食べログ", rating: 3, text: "コースの量はちょうど良いが、前菜の温度がぬるかった。店内が少し騒がしい。" },
  ],
  unrepliedCount: 7,
  samples: { low: [], high: [], recent: [] },
  comparison: null,
  generatedAt: "2026-09-30",
};
export const sampleAi = {
  title: "BISTRO CAVACAVA 7〜9月 分析レポート",
  summary: [
    "PVは48,210で直前期間比 +15.13%。8月にピーク（16,840）を記録し、9月も高水準を維持。",
    "一休のPVが +23.30% と伸びが大きく、予約124件（全体の約40%）を占める。",
    "新着口コミ46件、平均評価3.87。★2以下は6件で、提供の遅さに関する指摘が集中。",
    "未返信の口コミが7件あり、うち2件は★2以下。48時間以内の返信で印象の改善が見込める。",
  ],
  kpiComment: "夏季の記念日需要とテラス席の再開で、7月以降PVが月ごとに増加しました。予約件数も月100件前後で安定しています。",
  siteComment: "食べログはPVの8割を占める集客の柱ですが、評価は3.52と一休（4.50）より低く、写真と最新メニューの更新余地があります。",
  reviewSentiment: "料理の味と記念日の演出は高評価。一方で週末夜の提供スピードと店内の騒がしさに不満が見られます。",
  positiveThemes: [{ theme: "記念日の演出", detail: "デザートプレートのメッセージやスタッフの説明に好意的な声が多い。" }, { theme: "料理の味", detail: "メインの肉料理とソースの評価が安定して高い。" }],
  negativeThemes: [{ theme: "提供の遅さ", detail: "週末19〜21時のドリンク・追加注文の待ち時間に不満。" }, { theme: "料理の温度", detail: "前菜がぬるいという指摘が2件。" }],
  unrepliedComment: "★2以下の2件を優先し、提供体制の見直しを具体的に伝える返信を今週中に行いましょう。",
  recommendations: [
    { priority: "高", title: "週末夜のホール体制を1名増やす", detail: "金土の19〜21時にドリンク担当を追加し、提供待ちの口コミを減らす。" },
    { priority: "高", title: "未返信7件へ48時間以内に返信", detail: "低評価2件は改善策を添えて返信し、再来店のきっかけにする。" },
    { priority: "中", title: "食べログの写真・メニューを更新", detail: "秋の新メニューと記念日プレートの写真を追加し、評価とCVRの底上げを狙う。" },
    { priority: "低", title: "一休限定の平日コースを追加", detail: "伸びている一休の集客を平日の空席に振り向ける。" },
  ],
};
export const sampleReport = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  title: sampleAi.title, storeId: sampleFacts.store.id, storeName: sampleFacts.store.name, from: "2026-07-01", to: "2026-09-29",
  model: "gpt-6-luna", createdAt: "2026-09-30T01:23:00.000Z",
  markdown: composeReportMarkdown(sampleFacts, sampleAi, { title: sampleAi.title, model: "gpt-6-luna" }),
  content: { version: 1, facts: sampleFacts, ai: sampleAi, focus: null },
};
