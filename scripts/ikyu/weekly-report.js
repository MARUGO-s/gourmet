// 一休週報 HTML（エージェント／ローカル用）。見た目は全サイト共通の scripts/shared/weekly-report.js（サンプル週報 UI）。
// このファイルは一休固有の数値・文言を共通ビューへ詰めるアダプタと、取り込み JSON（scripts/ikyu-html-to-json.mjs の出力）
// や DB 行（ikyu_daily_pageviews / ikyu_monthly_pageviews / ikyu_stores）から週報入力を組み立てる関数。
// 内容ルール（青写真）: 未取得は空欄や 0 にせず「未取得」、事実と推測を分離、PII 禁止（クチコミは件数・評価・日付だけを使い、
// 予約番号・ハンドルネーム・本文は週報に入れない）。エクスポート入口: scripts/ikyu-weekly-report.mjs（または scripts/weekly-report.mjs --site ikyu）
// 詳細: docs/weekly-report.md
import {
  NA, clsDelta, dailyStats, deltaArrow, fmt, fmtDiff, fmtPct, isNum, mom, monthLabel, niceMax,
  pickMonthPair, renderWeeklyReportHtml, shortMd, shortMonth, slashDate,
} from "../shared/weekly-report.js";
import { shiftDate, weeklyPvWindows } from "../shared/weekly-windows.js";

export const IKYU_SITE = { key: "ikyu", label: "一休" };
const METRIC_KEYS = ["pv", "guide", "plan", "other", "sp", "pc", "reservations", "amount"];
// DB（snake_case）→ 取り込み JSON（camelCase）
const DB_KEY = { guide_total: "guide", plan_total: "plan", other_total: "other", reservation_amount: "amount" };
const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const yen = (n) => (isNum(n) ? `¥${fmt(n)}` : NA);
const pct1 = (num, den) => (isNum(num) && isNum(den) && Number(den) > 0 ? `${((Number(num) / Number(den)) * 100).toFixed(1)}%` : NA);
const perRes = (amount, res) => (isNum(amount) && isNum(res) && Number(res) > 0 ? Math.round(Number(amount) / Number(res)) : null);

function metricRow(row) {
  if (!row || typeof row !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(row)) out[DB_KEY[k] ?? k] = v;
  const pick = Object.fromEntries(METRIC_KEYS.map((k) => [k, isNum(out[k]) ? Number(out[k]) : null]));
  return pick;
}

/** 日別行の key 列を、PV 行がある日だけ合計（予約欄が空欄の日は管理画面の月合計と同じく 0 扱い）。PV 行が欠けた日があれば null */
export function sumIkyuDaily(rows, from, to, key) {
  const byDate = new Map((rows ?? []).filter((r) => r?.date >= from && r.date <= to && isNum(r.pv)).map((r) => [r.date, r]));
  let total = 0;
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    const r = byDate.get(d);
    if (!r) return null;
    total += isNum(r[key]) ? Number(r[key]) : 0;
  }
  return total;
}

/**
 * 一休の管理画面は前日分を空欄（未反映）で表示することがある（2026-10 の実画面で確認）。
 * 最後に PV が入っている日が作成日の 1〜2 日前なら、その翌日を日別の締め日にする（週次比較が毎回「未取得」になるのを避ける）。
 * それより古いデータしかない場合は締め日を動かさない（古い週を最新のように見せない → 欠けた期間は「未取得」）。
 */
export function ikyuDailyAsOf(daily, asOf) {
  const last = (daily ?? []).filter((d) => d?.date && d.date < asOf && isNum(d.pv)).map((d) => d.date).sort().at(-1);
  if (!last) return asOf;
  const next = shiftDate(last, 1);
  return next < asOf && next >= shiftDate(asOf, -2) ? next : asOf;
}

/**
 * 一休週報の入力を組み立てる（足りない節は null → 「未取得」）。
 * @param {object} a
 * @param {string} a.storeKey 一休の6桁の店舗ID
 * @param {string} [a.storeName]
 * @param {string} a.asOf YYYY-MM-DD（当日は集計中として日別から除外）
 * @param {object[]} [a.payloads] 取り込み JSON（schemaVersion 1）。複数可（capturedAt の古い順に重ね、新しい値で上書き）
 * @param {object[]} [a.monthlyRows] DB の ikyu_monthly_pageviews 行（snake/camel どちらでも）
 * @param {object[]} [a.dailyRows] DB の ikyu_daily_pageviews 行（snake/camel どちらでも）
 * @param {object[]|null} [a.reviews] 管理画面クチコミ（postedAt / publishedAt / rating / needsReply）。null=未取得
 * @param {object|null} [a.publicProfile] { rating, reviewCount, capturedOn }
 * @param {object[]|null} [a.publicReviews] 公開ページの口コミ（date / rating）。管理画面クチコミが無いときの新着判定に使う
 */
export function assembleIkyuWeeklyInput({
  storeKey, storeName, asOf, payloads = [], monthlyRows = [], dailyRows = [], reviews = null,
  publicProfile = null, publicReviews = null, competitors = [], areaRanks = [], nextActions,
  heroTitle, heroPoints, focusText, areaLabel, competitorInsight, reviewNote, reviewIdea,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf ?? ""))) throw new Error("asOf は YYYY-MM-DD です");
  const months = new Map(); // month -> { month, complete, days, ...metrics }
  const days = new Map(); // date -> { date, ...metrics }
  let name = storeName ?? null;
  let pub = publicProfile ? { ...publicProfile } : null;
  let pubReviews = publicReviews ? [...publicReviews] : null;
  let owner = Array.isArray(reviews) ? new Map(reviews.map((r, i) => [r.reservationNo ?? r.reservation_no ?? `row${i}`, r])) : null;
  const ownerCaptured = [];

  for (const r of monthlyRows ?? []) {
    if (!r?.month) continue;
    const metrics = metricRow(r);
    months.set(r.month, { month: r.month, complete: r.complete ?? null, days: r.days ?? null, ...metrics });
  }
  for (const r of dailyRows ?? []) {
    const date = typeof r?.date === "string" ? r.date.slice(0, 10) : null;
    if (date) days.set(date, { date, ...metricRow(r) });
  }

  const sorted = [...(payloads ?? [])].filter(Boolean).sort((x, y) => String(x.capturedAt ?? "").localeCompare(String(y.capturedAt ?? "")));
  for (const p of sorted) {
    if (p.source != null && p.source !== "ikyu") throw new Error("一休の取り込み JSON（source=ikyu）を指定してください");
    const stores = p.stores ?? [];
    const store = stores.find((s) => String(s.storeId) === String(storeKey)) ?? (storeKey ? null : stores[0]);
    if (!store) continue;
    const capturedOn = p.capturedAt ? new Date(Date.parse(p.capturedAt) + 9 * 3600e3).toISOString().slice(0, 10) : null;
    name = name ?? store.name ?? null;
    for (const m of store.pageviews?.months ?? []) {
      // 取得日（日本時間）以降の日は取得時点で集計中だったため使わない。作成日 asOf 以降も除外
      const kept = (m.days ?? []).filter((d) => d?.date && d.date < asOf && (!capturedOn || d.date < capturedOn) && isNum(d.pv));
      for (const d of kept) days.set(d.date, { date: d.date, ...metricRow(d) });
      const sumKey = (k) => (kept.length && kept.every((d) => isNum(d[k])) ? kept.reduce((a, d) => a + Number(d[k]), 0) : null);
      const totals = m.totals ? metricRow(m.totals) : Object.fromEntries(METRIC_KEYS.map((k) => [k, sumKey(k)]));
      const complete = m.month < asOf.slice(0, 7) && kept.length === daysInMonth(m.month);
      // 確定済みの月を、後の取り込みの途中月で上書きしない
      if (months.get(m.month)?.complete && !complete) continue;
      // 月合計行は集計中の日を含むことがあるため、確定月以外は日別の合計を使う
      months.set(m.month, { month: m.month, complete, days: kept.length, ...(complete ? totals : Object.fromEntries(METRIC_KEYS.map((k) => [k, sumKey(k)]))) });
    }
    if (store.reviews) {
      owner = owner ?? new Map();
      for (const r of store.reviews.items ?? []) owner.set(r.reservationNo, r);
      if (capturedOn) ownerCaptured.push(capturedOn);
    }
    if (store.public) {
      pub = { rating: store.public.rating ?? null, reviewCount: store.public.reviewCount ?? null, capturedOn };
      pubReviews = (store.public.reviews ?? []).map((r) => ({ date: r.date, rating: r.rating }));
    }
  }

  const monthList = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const { cur, prev } = pickMonthPair(monthList, asOf, {
    consecutive: true,
    isComplete: (m) => m.complete == null ? (m.days == null || m.days === daysInMonth(m.month)) : m.complete,
  });
  const windows = weeklyPvWindows(asOf);
  const inLast7 = (d) => d && d >= windows.last7.from && d <= windows.last7.to;
  // PII を落とす: 件数・評価・日付・要返信だけ残す
  const ownerItems = owner ? [...owner.values()].map((r) => ({
    postedAt: r.postedAt ?? r.posted_at ?? null,
    publishedAt: r.publishedAt ?? r.published_at ?? null,
    rating: isNum(r.rating) ? Number(r.rating) : null,
    needsReply: typeof (r.needsReply ?? r.needs_reply) === "boolean" ? (r.needsReply ?? r.needs_reply) : null,
  })) : null;
  let newReviews7d = null, newReviewsBasis = null;
  if (ownerItems) {
    newReviews7d = ownerItems.filter((r) => inLast7(r.postedAt ?? r.publishedAt)).length;
    newReviewsBasis = "owner";
  } else if (pubReviews) {
    newReviews7d = pubReviews.filter((r) => inLast7(r.date)).length;
    newReviewsBasis = "public";
  }
  const needsReply = ownerItems ? ownerItems.filter((r) => r.needsReply === true).length : null;
  const strip = (m) => (m ? Object.fromEntries(["month", ...METRIC_KEYS].map((k) => [k, m[k] ?? null])) : {});
  return {
    storeKey: String(storeKey ?? ""),
    storeName: name || (storeKey ? `一休 店舗${storeKey}` : "店舗"),
    asOf,
    monthly: { prev: strip(prev), cur: strip(cur) },
    daily: [...days.values()].filter((d) => d.date < asOf).sort((a, b) => a.date.localeCompare(b.date)),
    publicProfile: pub ?? {},
    ownerReviews: ownerItems ? { count: ownerItems.length, needsReply, capturedFrom: ownerCaptured.sort()[0] ?? null, capturedOn: ownerCaptured.sort().at(-1) ?? null } : null,
    newReviews7d,
    newReviewsBasis,
    competitors: competitors ?? [],
    areaRanks: areaRanks ?? [],
    nextActions, heroTitle, heroPoints, focusText, areaLabel, competitorInsight, reviewNote, reviewIdea,
  };
}

/** 一休の週報入力 → 共通テンプレートのビュー */
export function buildIkyuWeeklyView(input) {
  const asOf = input.asOf;
  const name = input.storeName || "店舗";
  const daily = input.daily ?? [];
  const dailyAsOf = ikyuDailyAsOf(daily, asOf);
  const { windows, last7, wow } = dailyStats(daily, dailyAsOf);
  const reviewWindows = weeklyPvWindows(asOf);
  const cur = input.monthly?.cur ?? {};
  const prev = input.monthly?.prev ?? {};
  const pvMom = mom(cur.pv, prev.pv);
  const resMom = mom(cur.reservations, prev.reservations);
  const amtMom = mom(cur.amount, prev.amount);
  const profile = input.publicProfile ?? {};
  const owner = input.ownerReviews ?? null;
  const newReviews7d = input.newReviews7d ?? null;
  const competitors = input.competitors ?? [];
  const otherComps = competitors.filter((c) => !c.own);
  const areaLabel = input.areaLabel || "設定エリア";
  const n = (text) => ({ text, num: true });
  const val = (x) => (isNum(x) ? Number(x) : null);
  const monthsSub = `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値`;
  const periodLabelPrev = `${shortMd(windows.prior7.from)}–${shortMd(windows.prior7.to)}`;
  const periodLabelLast = `${shortMd(windows.last7.from)}–${shortMd(windows.last7.to)}`;
  const reviewPeriodLabel = `${shortMd(reviewWindows.last7.from)}–${shortMd(reviewWindows.last7.to)}`;

  const wk = (key, w) => sumIkyuDaily(daily, w.from, w.to, key);
  const res7 = wk("reservations", windows.last7), resPrior7 = wk("reservations", windows.prior7);
  const amt7 = wk("amount", windows.last7), amtPrior7 = wk("amount", windows.prior7);
  const plan7 = wk("plan", windows.last7), planPrior7 = wk("plan", windows.prior7);

  const defaultTitle = (() => {
    if (isNum(wow) && wow > 0) return ["閲覧は回復。", "次は、プランから予約へ。"];
    if (isNum(wow) && wow < 0) return ["閲覧は軟調。", "プラン導線と口コミを確認。"];
    if (isNum(pvMom) && pvMom > 0) return ["月次の閲覧は堅調。", "次は、プランから予約へ。"];
    return [name, "今週の確認ポイント"];
  })();

  const points = [];
  if (isNum(cur.pv) && isNum(prev.pv)) {
    const weeklyBit = isNum(last7.pv) && isNum(wow)
      ? `直近7日（${periodLabelLast}）は${fmt(last7.pv)}PVで前7日比${fmtPct(wow)}。`
      : "";
    points.push(`${shortMonth(cur.month)}のPVは**${fmt(cur.pv)}**（${shortMonth(prev.month)}${fmt(prev.pv)}から${fmtPct(pvMom)}）。${weeklyBit}`);
  } else if (isNum(cur.pv)) {
    points.push(`${shortMonth(cur.month)}のPVは**${fmt(cur.pv)}**（前月：未取得）。`);
  } else points.push("月次PV：未取得。");
  if (isNum(cur.reservations)) {
    const prevBit = isNum(prev.reservations) ? `（${shortMonth(prev.month)} ${fmt(prev.reservations)}件・${yen(prev.amount)}）` : "（前月：未取得）";
    points.push(`${shortMonth(cur.month)}の予約受付は**${fmt(cur.reservations)}件・${yen(cur.amount)}**${prevBit}。受付日ベースの値です。`);
  } else points.push("月次の予約件数・金額：未取得。");
  points.push(isNum(res7)
    ? `直近7日の予約受付は**${fmt(res7)}件**（前7日 ${isNum(resPrior7) ? `${fmt(resPrior7)}件` : NA}）。`
    : "直近7日の予約受付：未取得。");
  {
    const revBit = newReviews7d == null ? "直近7日の新着クチコミは未取得" : `直近7日の新着クチコミは**${fmt(newReviews7d)}件**`;
    const ratingBit = isNum(profile.rating) ? `公開評価${Number(profile.rating).toFixed(2)}・口コミ${fmt(profile.reviewCount)}件` : "公開評価・口コミ数は未取得";
    const replyBit = owner && isNum(owner.needsReply) && owner.needsReply > 0 ? `、要返信${fmt(owner.needsReply)}件` : "";
    points.push(`${revBit}。${ratingBit}${replyBit}。`);
  }

  const focus = input.focusText ?? (isNum(cur.reservations) && isNum(prev.reservations)
    ? `予約受付が **${fmt(prev.reservations)}件 → ${fmt(cur.reservations)}件** に変化。プラン詳細の閲覧${isNum(cur.plan) ? `（${shortMonth(cur.month)} ${fmt(cur.plan)}PV）` : ""}から予約までの導線と、来店後のクチコミ返信を優先します。※予約件数は当日に入った予約の件数で、来店数や売上確定額ではありません。`
    : owner && owner.needsReply > 0
      ? `要返信のクチコミが **${fmt(owner.needsReply)}件** あります。返信内容を確認し、プラン詳細から予約までの導線もあわせて点検します。`
      : "データがそろい次第、最優先の課題を表示します。");

  const metrics = [
    {
      key: "pv", button: "閲覧数",
      title: isNum(cur.pv) && isNum(pvMom) ? `ページ閲覧数は前月比${Math.abs(pvMom).toFixed(1)}%${pvMom >= 0 ? "増" : "減"}` : (isNum(cur.pv) ? "ページ閲覧数" : "ページ閲覧数（未取得）"),
      subtitle: `${monthsSub} / PV`, values: [val(prev.pv), val(cur.pv)], max: niceMax(Math.max(Number(prev.pv) || 0, Number(cur.pv) || 0)), unit: "PV",
      change: fmtPct(pvMom), cls: clsDelta(pvMom),
      explain: isNum(cur.pv) && isNum(prev.pv)
        ? `閲覧数の差分は ${fmtDiff(cur.pv, prev.pv)}PV。店舗ガイド・プラン詳細・その他の合計です。`
        : "月次PVが未取得です。",
    },
    {
      key: "booking", button: "予約件数",
      title: isNum(cur.reservations) && isNum(prev.reservations)
        ? `予約受付は${fmt(prev.reservations)}件から${fmt(cur.reservations)}件へ`
        : (isNum(cur.reservations) ? `予約受付は${fmt(cur.reservations)}件` : "予約件数（未取得）"),
      subtitle: `${monthsSub} / 件`, values: [val(prev.reservations), val(cur.reservations)], max: niceMax(Math.max(Number(prev.reservations) || 0, Number(cur.reservations) || 0)), unit: "件",
      change: fmtPct(resMom), cls: clsDelta(resMom),
      explain: "管理画面「日付別アクセス集計」の予約状況（当日に入った予約）の件数です。来店日ベースの件数とは異なります。",
    },
    {
      key: "amount", button: "予約金額",
      title: isNum(cur.amount) && isNum(prev.amount)
        ? `予約金額は${yen(prev.amount)}から${yen(cur.amount)}へ`
        : (isNum(cur.amount) ? `予約金額は${yen(cur.amount)}` : "予約金額（未取得）"),
      subtitle: `${monthsSub} / 円`, values: [val(prev.amount), val(cur.amount)], max: niceMax(Math.max(Number(prev.amount) || 0, Number(cur.amount) || 0)), unit: "円",
      change: fmtPct(amtMom), cls: clsDelta(amtMom),
      explain: "予約受付時の合計金額（管理画面の表示値）です。売上確定額ではありません。",
    },
  ];

  const triple = (m, keys) => (keys.some((k) => isNum(m[k])) ? keys.map((k) => fmt(m[k])).join("／") : NA);
  const share = (part, total) => pct1(part, total);

  const reviewNote = input.reviewNote ?? (newReviews7d == null
    ? "新着クチコミ件数は未取得です。管理画面「クチコミ確認・返信」または公開ページの口コミ一覧を取得すると判定できます。"
    : input.newReviewsBasis === "public"
      ? `公開ページの口コミ一覧の投稿日で判定しました（確認範囲の新着 ${fmt(newReviews7d)} 件）。公開ページに出ていないクチコミは含みません。`
      : `管理画面「クチコミ確認・返信」の投稿日で判定しました（確認範囲の新着 ${fmt(newReviews7d)} 件）。来店日と投稿日は区別しています。氏名・ハンドルネーム・予約番号は記載しません。`);
  const reviewIdea = input.reviewIdea ?? (owner && owner.needsReply > 0
    ? `改善・返信のアイデア：要返信のクチコミ（${fmt(owner.needsReply)}件）は、来店のお礼と具体的な料理・サービスへの言及を添えて返信する。`
    : "改善・返信のアイデア：直近のクチコミが少ない／ない状態が続く場合は、来店時やお礼メールで一休へのクチコミ投稿を案内する導線を用意する。");

  const ownRatingText = isNum(profile.rating) ? Number(profile.rating).toFixed(2) : NA;
  const ratedOthers = otherComps.filter((c) => isNum(c.rating));
  const perResCur = perRes(cur.amount, cur.reservations);

  const nextActions = input.nextActions?.length ? input.nextActions : [
    { title: "プラン詳細から予約へつなぐ", body: isNum(cur.plan) && isNum(cur.reservations)
      ? `${shortMonth(cur.month)}はプラン詳細${fmt(cur.plan)}PVに対して予約受付${fmt(cur.reservations)}件。プランの写真・価格・利用条件・空席表示がそろっているか確認します。`
      : "プランの写真・価格・利用条件・空席表示がそろっているか確認します。" },
    { title: "クチコミへの返信と依頼", body: owner && isNum(owner.needsReply)
      ? `管理画面で要返信のクチコミは${fmt(owner.needsReply)}件。返信を済ませ、来店時やお礼メールでクチコミ投稿を案内します。`
      : "管理画面「クチコミ確認・返信」で要返信の有無を確認し、来店時やお礼メールでクチコミ投稿を案内します。" },
    { title: "空席とプラン掲載をそろえる", body: "予約カレンダーの空席・販売期間と、店舗ガイドで見せている内容（コース・価格帯）が一致しているか確認します。" },
  ];

  return {
    site: IKYU_SITE,
    storeName: name,
    storeKey: input.storeKey,
    asOf,
    dailyAsOf,
    daily: daily.map((d) => ({ date: d.date, pv: d.pv })),
    hero: { title: (input.heroTitle?.length ? input.heroTitle : defaultTitle).slice(0, 2), points: (input.heroPoints?.length ? input.heroPoints : points).slice(0, 5), focus },
    kpis: [
      { label: `${shortMonth(cur.month)}のページ閲覧数`, value: fmt(cur.pv), unit: "PV", deltaCls: clsDelta(pvMom), delta: isNum(pvMom) ? deltaArrow(pvMom) : NA, note: isNum(prev.pv) ? `${shortMonth(prev.month)} ${fmt(prev.pv)} PV` : "前月：未取得" },
      { label: `${shortMonth(cur.month)}の予約受付`, value: fmt(cur.reservations), unit: "件", deltaCls: clsDelta(resMom), delta: isNum(resMom) ? deltaArrow(resMom) : NA, note: isNum(prev.reservations) ? `${shortMonth(prev.month)} ${fmt(prev.reservations)}件／受付日ベース` : "受付日ベース／前月：未取得" },
      { label: `${shortMonth(cur.month)}の予約金額`, value: fmt(cur.amount), unit: "円", deltaCls: clsDelta(amtMom), delta: isNum(amtMom) ? deltaArrow(amtMom) : NA, note: isNum(prev.amount) ? `${shortMonth(prev.month)} ${yen(prev.amount)}／売上確定額ではありません` : "売上確定額ではありません／前月：未取得" },
      { label: "直近7日の新着クチコミ", value: fmt(newReviews7d), unit: "件", deltaCls: "neutral", delta: reviewPeriodLabel, note: `公開口コミ累計${fmt(profile.reviewCount)}${isNum(profile.reviewCount) ? "件" : ""}` },
    ],
    monthly: {
      heading: { number: "01 / STORE ADMIN", title: "店舗管理データ：閲覧と予約の動き", lead: "見たい指標を選ぶと、月次グラフが切り替わります。" },
      periods: [shortMonth(prev.month), shortMonth(cur.month)],
      subtitle: monthsSub,
      metrics,
      caption: "月次の閲覧・予約件数・予約金額を切り替えで確認できます。",
      table: {
        caption: "表1 月次比較（出典：店舗管理画面「日付別アクセス集計」月合計／単位：PV・件・円）",
        head: [{ label: "指標" }, { label: monthLabel(prev.month), num: true }, { label: monthLabel(cur.month), num: true }, { label: "増減", num: true }, { label: "前月比", num: true }],
        rows: [
          { cells: ["アクセス数（PV）", n(fmt(prev.pv)), n(fmt(cur.pv)), n(fmtDiff(cur.pv, prev.pv)), n(fmtPct(pvMom))] },
          { cells: ["予約件数（受付日ベース・件）", n(fmt(prev.reservations)), n(fmt(cur.reservations)), n(fmtDiff(cur.reservations, prev.reservations)), n(fmtPct(resMom))] },
          { cells: ["予約金額（受付日ベース・円）", n(fmt(prev.amount)), n(fmt(cur.amount)), n(fmtDiff(cur.amount, prev.amount)), n(fmtPct(amtMom))] },
          { cells: ["予約1件あたり金額（計算値・円）", n(fmt(perRes(prev.amount, prev.reservations))), n(fmt(perResCur)), n("—"), n("—")] },
          { cells: ["予約率（予約件数÷PV・計算値）", n(pct1(prev.reservations, prev.pv)), n(pct1(cur.reservations, cur.pv)), n("—"), n("—")] },
          { cells: ["PV内訳 店舗ガイド／プラン詳細／その他", n(triple(prev, ["guide", "plan", "other"])), n(triple(cur, ["guide", "plan", "other"])), n("—"), n("—")] },
          { cells: ["PV内訳 スマホ／PC", n(triple(prev, ["sp", "pc"])), n(triple(cur, ["sp", "pc"])), n("—"), n("—")] },
        ],
      },
    },
    weekly: {
      source: "一休 店舗管理画面「日付別アクセス集計」（日別）",
      table: {
        caption: `表2 直近7日の予約受付とプラン閲覧（出典：店舗管理画面「日付別アクセス集計」日別／${slashDate(asOf)} 確認時点／単位：件・円・PV）`,
        head: [{ label: "区分" }, { label: `前の7日間（${periodLabelPrev}）`, num: true }, { label: `直近7日間（${periodLabelLast}）`, num: true }],
        rows: [
          { cells: ["予約件数（件）", n(fmt(resPrior7)), n(fmt(res7))] },
          { cells: ["予約金額（円）", n(fmt(amtPrior7)), n(fmt(amt7))] },
          { cells: ["プラン詳細の閲覧（PV）", n(fmt(planPrior7)), n(fmt(plan7))] },
        ],
      },
      tableNote: "※予約は当日に入った予約（受付日ベース）です。予約欄が空欄の日は、管理画面の月合計と同じく予約なしとして合計しています。日別の行が欠けた期間は「未取得」です。顧客の氏名・連絡先は記載しません。",
    },
    dailyPanel: { source: "日付別アクセス集計（日別）", tableSource: "一休 店舗管理画面「日付別アクセス集計」" },
    reviews: {
      profileTitle: "評価・クチコミ",
      profileTable: {
        caption: `表4 評価・クチコミの指標（出典：一休公開店舗ページ${profile.capturedOn ? `（${slashDate(profile.capturedOn)} 取得）` : ""}・店舗管理画面「クチコミ確認・返信」${owner?.capturedOn ? `（${owner.capturedFrom && owner.capturedFrom !== owner.capturedOn ? `${slashDate(owner.capturedFrom)}–` : ""}${slashDate(owner.capturedOn)} 取得）` : ""}）`,
        head: [{ label: "指標" }, { label: "値", num: true }, { label: "単位" }],
        rows: [
          { cells: ["総合評価（公開ページ）", n(ownRatingText), "点（5点満点）"] },
          { cells: ["口コミ数（公開ページ）", n(fmt(profile.reviewCount)), "件"] },
          { cells: ["管理画面クチコミ（取り込み済み）", n(owner ? fmt(owner.count) : NA), "件"] },
          { cells: ["うち要返信", n(owner && isNum(owner.needsReply) ? fmt(owner.needsReply) : NA), "件"] },
        ],
      },
      newTitle: "直近7日の新着クチコミ",
      statText: newReviews7d == null ? NA : newReviews7d === 0 ? "該当クチコミなし" : `${fmt(newReviews7d)}件`,
      note: reviewNote,
      idea: reviewIdea,
    },
    competitors: {
      heading: { number: "03 / COMPETITORS", title: "競合比較（評価上位店）", lead: "評価と口コミ件数を切り替えて確認できます。" },
      areaLabel,
      list: competitors.map((c) => ({ name: c.own ? `${name}（自店）` : c.name, rating: c.rating ?? null, reviews: c.reviews ?? null, own: !!c.own })),
      insight: input.competitorInsight ?? (ratedOthers.length && isNum(profile.rating)
        ? `自店の公開評価は${ownRatingText}。比較店（${Math.min(...ratedOthers.map((c) => c.rating)).toFixed(2)}–${Math.max(...ratedOthers.map((c) => c.rating)).toFixed(2)}）と並べています。`
        : "一休の競合スナップショット：未取得（エリア上位店の取得は未対応）。"),
      side: {
        title: "価格帯の確認",
        sub: "一休の予約実績（管理画面の表示値）から計算",
        opportunity: isNum(perResCur) ? { tag: `${shortMonth(cur.month)}の予約1件あたり金額（計算値）`, price: yen(perResCur), note: "予約金額÷予約件数の計算値です。人数・コース内訳は含みません。比較店のプラン価格は未取得です。" } : null,
        missing: "予約1件あたり金額",
        bullets: [
          { label: "評価", text: `${ownRatingText}${ratedOthers.length ? ` ／ 比較店 ${Math.min(...ratedOthers.map((c) => c.rating)).toFixed(2)}–${Math.max(...ratedOthers.map((c) => c.rating)).toFixed(2)}` : " ／ 比較店：未取得"}` },
          { label: "口コミ数", text: `${fmt(profile.reviewCount)} ／ 比較店：${otherComps.some((c) => isNum(c.reviews)) ? "一覧参照" : NA}` },
          { label: "プラン価格", text: "比較店：未取得。プラン掲載ページの取得後に比較します。" },
        ],
      },
      table: competitors.length ? {
        caption: `表5 競合比較（出典：一休公開ページ／${slashDate(asOf)} 取得／評価は点、口コミは件）`,
        head: [{ label: "#" }, { label: "店名" }, { label: "評価", num: true }, { label: "口コミ", num: true }, { label: "価格帯" }, { label: "最寄駅" }],
        rows: competitors.map((c, i) => ({ cls: c.own ? "own" : "", cells: [c.own ? "—" : String(i + 1), `${c.name}${c.own ? "（自店）" : ""}`, n(isNum(c.rating) ? Number(c.rating).toFixed(2) : NA), n(fmt(c.reviews)), c.price ?? NA, c.station ?? NA] })),
      } : null,
      changeNote: "前回スナップショットが無い項目は、変化の有無を推定していません。",
      missing: "一休の競合詳細",
    },
    area: {
      heading: { number: "04 / PAGES & AREA", title: "ページ別の閲覧とエリア順位" },
      panels: [
        {
          title: `ページ種別・端末の内訳（${monthLabel(cur.month)}）`,
          sub: "店舗ガイド・プラン詳細・その他、スマホ・PC",
          stat: isNum(cur.plan) && isNum(cur.pv) ? `プラン詳細 ${share(cur.plan, cur.pv)}` : NA,
          table: {
            caption: "表6 ページ種別・端末別の閲覧（出典：店舗管理画面「日付別アクセス集計」月合計／単位：PV）",
            head: [{ label: "区分" }, { label: monthLabel(prev.month), num: true }, { label: monthLabel(cur.month), num: true }, { label: "構成比", num: true }],
            rows: [
              ["店舗ガイド", "guide"], ["プラン詳細", "plan"], ["その他", "other"], ["スマホ", "sp"], ["PC", "pc"],
            ].map(([label, k]) => ({ cells: [label, n(fmt(prev[k])), n(fmt(cur[k])), n(share(cur[k], cur.pv))] })),
          },
          notes: ["PVは表示回数（ユニーク数ではありません）。構成比は当月合計PVに対する割合です。"],
        },
        {
          title: "自店のエリア内順位・新規オープン",
          sub: areaLabel,
          table: {
            caption: `表7 エリア順位など（出典：一休公開ページ／${slashDate(asOf)} 時点）`,
            head: [{ label: "項目" }, { label: "値", num: true }, { label: "備考" }],
            rows: [
              ...((input.areaRanks ?? []).length
                ? input.areaRanks.map((g) => ({ cells: [g.label, n(g.rank != null ? fmt(g.rank) : NA), g.note ?? ""] }))
                : [{ cells: ["エリア内順位", n(NA), "一休のエリア順位は取得対象外"] }]),
              { cells: ["直近30日の新規オープン", n(NA), "一休の新着店舗一覧は取得対象外"] },
            ],
          },
          notes: ["未取得の項目は推定で埋めていません。"],
        },
      ],
    },
    actions: nextActions,
    footnotes: [
      "月次・週次・日別・確認時点のデータは対象期間が異なるため、同じ集計として扱いません。",
      "予約件数・金額は管理画面「日付別アクセス集計」の予約状況（当日に入った予約）＝受付日ベースです。来店日ベースの件数や売上確定額ではありません。",
      "PVは表示回数（ユニーク数ではありません）。未取得の項目は空欄やゼロにせず「未取得」と記載します。予約1件あたり金額・予約率は表示値からの計算値です。",
      "クチコミは件数・評価・投稿日だけを扱い、予約者の氏名・ハンドルネーム・予約番号・本文は記載しません。",
      "グラフの切り替えはこのファイル内の表示だけに作用し、外部への通信は行いません。",
    ],
    footer: {
      left: `${name} · 一休週報 · 作成日 ${slashDate(asOf)}（Asia/Tokyo）`,
      right: `出典：一休.comレストラン 店舗管理画面・公開ページ${input.storeKey ? ` · 店舗ID ${input.storeKey}` : ""}`,
    },
  };
}

/** 一休週報 HTML（共通テンプレートで描画） */
export function buildIkyuWeeklyReportHtml(input) {
  return renderWeeklyReportHtml(buildIkyuWeeklyView(input));
}
