import { japanDate } from './sync-data.js';
const DAY_MS = 86_400_000;
const shiftDate = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;
function previousMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

// ---------- 共通: ダッシュボード集計（純粋関数・DB行/デモ行の両方に対応） ----------
// snapshots の保存規約（食べログ）:
//   - 日別PV は各日付の行の pv
//   - 月別の予約組数はその月の1日の行の reservations（食べログは月単位でしか提供しない）
//   - 評価・口コミ数は同期した日の行の rating / reviews（rating = 0 は「値なし」）
export function computeDashboard(snapshots, reviews, lastSync, targets, demo) {
  const rows = snapshots.filter((s) => targets.includes(s.source));

  // 日別PV: PVを持つ日だけを対象にする（月初の予約専用行・集計前の当日行を除外）
  const pvByDate = new Map();
  for (const s of rows) pvByDate.set(s.date, (pvByDate.get(s.date) ?? 0) + Number(s.pv));
  const daily = [...pvByDate]
    .filter(([, pv]) => pv > 0)
    .map(([date, pv]) => ({ date, pv }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const latestDate = daily.at(-1)?.date ?? null;
  const pvBetween = (from, to) =>
    daily.filter((d) => d.date >= from && d.date <= to).reduce((total, d) => total + d.pv, 0);
  let pv = { value: 0, delta: 0 };
  if (latestDate) {
    const now = pvBetween(shiftDate(latestDate, -6), latestDate);
    const prevFrom = shiftDate(latestDate, -13);
    const prevTo = shiftDate(latestDate, -7);
    const hasPrev = daily.some((d) => d.date >= prevFrom && d.date <= prevTo);
    pv = { value: now, delta: hasPrev ? now - pvBetween(prevFrom, prevTo) : 0 };
  }
  const series = latestDate ? daily.filter((d) => d.date > shiftDate(latestDate, -45)) : [];

  // 評価・口コミ数: サイトごとに値のある最新行と、その7日以上前の値のある最新行を比較
  let ratingSum = 0;
  let ratingCount = 0;
  let reviewsNow = 0;
  let ratingDeltaSum = 0;
  let reviewsDelta = 0;
  let deltaCount = 0;
  for (const id of targets) {
    const own = rows
      .filter((s) => s.source === id && Number(s.rating) > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const current = own.at(-1);
    if (!current) continue;
    ratingSum += Number(current.rating);
    ratingCount += 1;
    reviewsNow += Number(current.reviews);
    const prior = own.filter((s) => s.date <= shiftDate(current.date, -7)).at(-1);
    if (prior) {
      ratingDeltaSum += Number(current.rating) - Number(prior.rating);
      reviewsDelta += Number(current.reviews) - Number(prior.reviews);
      deltaCount += 1;
    }
  }

  // 予約組数: 月別合計。今月は未確定のため、前月以前で最新の月を表示する
  const thisMonth = japanDate().slice(0, 7);
  const byMonth = new Map();
  for (const s of rows) {
    const month = s.date.slice(0, 7);
    if (month < thisMonth) byMonth.set(month, (byMonth.get(month) ?? 0) + Number(s.reservations));
  }
  const latestMonth = [...byMonth.keys()].sort().at(-1) ?? null;
  const monthNow = latestMonth ? byMonth.get(latestMonth) : 0;
  const prevMonthKey = latestMonth ? previousMonth(latestMonth) : null;

  return {
    kpis: {
      rating: {
        value: ratingCount ? round2(ratingSum / ratingCount) : 0,
        delta: deltaCount ? round2(ratingDeltaSum / deltaCount) : 0,
      },
      reviews: { value: reviewsNow, delta: reviewsDelta },
      pv,
      reservations: {
        value: monthNow,
        delta: byMonth.has(prevMonthKey) ? monthNow - byMonth.get(prevMonthKey) : 0,
        month: latestMonth,
      },
    },
    series,
    reviews: reviews
      .filter((r) => targets.includes(r.source))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 20),
    lastSync,
    demo,
  };
}


export async function loadDetails(client, source, fromDate) {
  const [summary, daily] = await Promise.all([
    client.from("source_reports").select("kind,period,data").eq("source", source).neq("kind", "device_daily"),
    client
      .from("source_reports")
      .select("period,data")
      .eq("source", source)
      .eq("kind", "device_daily")
      .gte("period", fromDate ?? "0000-00-00"),
  ]);
  const error = summary.error ?? daily.error;
  if (error) {
    console.warn(`[dashboard] detail reports unavailable: ${error.message}`);
    return { unavailable: true };
  }
  const byKind = (kind) =>
    summary.data.filter((row) => row.kind === kind).sort((a, b) => (a.period < b.period ? 1 : -1));
  return {
    ranking: byKind("area_ranking")[0]?.data ?? null,
    topPages: byKind("top_pages")[0]?.data ?? null,
    monthly: byKind("monthly_metrics")
      .slice(0, 13)
      .map((row) => ({ month: row.period, ...row.data })),
    deviceDaily: Object.fromEntries(daily.data.map((row) => [row.period, row.data])),
  };
}
