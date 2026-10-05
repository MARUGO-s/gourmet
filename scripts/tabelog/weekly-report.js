// 食べログ週報 HTML 生成（オフライン。外部リソースなし）。エージェント／ローカル用。
// UI はサンプル週報 HTML（hero / KPI / panels / charts / competitor bars / actions / footnotes）に合わせる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pctChange, shiftDate, sumDailyPv, weeklyPvWindows, within30Days } from "./weekly-windows.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const loadCss = () => fs.readFileSync(path.join(__dir, "weekly-report.css.txt"), "utf8");

const NA = "未取得";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isNum = (n) => n != null && Number.isFinite(Number(n));
const fmt = (n) => (isNum(n) ? Number(n).toLocaleString("ja-JP") : NA);
const fmtPct = (n) => {
  if (n == null || !Number.isFinite(n)) return NA;
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
};
const clsDelta = (n) => (n == null || !Number.isFinite(n) ? "neutral" : n > 0 ? "positive" : n < 0 ? "negative" : "neutral");
const yen = (s) => (s ? esc(s) : "掲載なし");
const deltaArrow = (n) => {
  if (n == null || !Number.isFinite(n)) return "";
  if (n > 0) return `↑ 前月比 ${Math.abs(n).toFixed(1)}%増`;
  if (n < 0) return `↓ 前月比 ${Math.abs(n).toFixed(1)}%減`;
  return "前月比 変化なし";
};
const niceMax = (v) => {
  const n = Number(v) || 0;
  if (n <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(n));
  return Math.ceil((n * 1.15) / exp) * exp;
};
const monthLabel = (ym) => {
  if (!ym) return NA;
  const [y, m] = ym.split("-");
  return `${Number(y)}年${Number(m)}月`;
};
const shortMonth = (ym) => (ym ? `${Number(ym.slice(5))}月` : NA);
const slashDate = (ymd) => (ymd ? ymd.replace(/-/g, "/") : NA);
const dotDate = (ymd) => (ymd ? ymd.replace(/-/g, ".") : NA);
const shortMd = (ymd) => {
  if (!ymd) return "";
  return `${ymd.slice(5, 7)}/${ymd.slice(8)}`;
};
const weekdayJa = (date) => ["日", "月", "火", "水", "木", "金", "土"][new Date(`${date}T00:00:00Z`).getUTCDay()];
const mdJa = (ymd) => {
  if (!ymd) return NA;
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}（${weekdayJa(ymd)}）`;
};
const fillPct = (value, max) => {
  if (!isNum(value) || !isNum(max) || max <= 0) return "0%";
  return `${Math.max(0, Math.min(100, (Number(value) / Number(max)) * 100))}%`;
};

/**
 * @param {object} input
 * @param {string} input.storeName
 * @param {string} input.storeKey
 * @param {string} input.asOf YYYY-MM-DD
 * @param {object} [input.monthly] { prev: {month,pv,reservations,calls,pvPc,pvSp,pvApp}, cur: {...} }
 * @param {Array<{date,pv}>} [input.daily]
 * @param {object} [input.publicProfile] { rating, reviewCount, saveCount, budgetNight, budgetDay, station }
 * @param {object} [input.notices] { new, changed, cancelled }
 * @param {number|null} [input.newReviews7d]
 * @param {object} [input.accessRanking] { area, self: {rank,pv}, momPct, competitorsNote }
 * @param {Array} [input.competitors] top+self profiles
 * @param {Array} [input.genreRanks] { label, rank, note }
 * @param {Array} [input.newOpens]
 * @param {Array<{title,body}>} [input.nextActions]
 * @param {string[]} [input.heroTitle] two headline lines
 * @param {string[]} [input.heroPoints] bullet points (may include **bold** markers)
 * @param {string} [input.focusText]
 * @param {string} [input.areaLabel]
 * @param {string} [input.competitorInsight]
 * @param {string} [input.competitorChangeNote]
 * @param {string} [input.reviewNote]
 * @param {string} [input.reviewIdea]
 */
export function buildWeeklyReportHtml(input) {
  const asOf = input.asOf;
  const name = input.storeName || "店舗";
  const css = loadCss();
  const windows = weeklyPvWindows(asOf);
  const daily = input.daily ?? [];
  const last7 = sumDailyPv(daily, windows.last7.from, windows.last7.to);
  const prior7 = sumDailyPv(daily, windows.prior7.from, windows.prior7.to);
  const wow = isNum(last7.pv) && isNum(prior7.pv) ? pctChange(last7.pv, prior7.pv) : null;
  const last30 = daily
    .filter((d) => d.date >= windows.last30.from && d.date <= windows.last30.to && isNum(d.pv))
    .sort((a, b) => a.date.localeCompare(b.date));
  const peaks = [...last30].sort((a, b) => b.pv - a.pv).slice(0, 4);
  const dips = [...last30].sort((a, b) => a.pv - b.pv).slice(0, 4);
  const peakSet = new Set(peaks.map((d) => d.date));
  const dipSet = new Set(dips.map((d) => d.date));
  const sum30 = last30.reduce((a, d) => a + Number(d.pv), 0);
  const avg30 = last30.length ? sum30 / last30.length : null;

  const cur = input.monthly?.cur ?? {};
  const prev = input.monthly?.prev ?? {};
  const pvMom = isNum(cur.pv) && isNum(prev.pv) ? pctChange(cur.pv, prev.pv) : null;
  const resMom = isNum(cur.reservations) && isNum(prev.reservations) ? pctChange(cur.reservations, prev.reservations) : null;
  const callMom = isNum(cur.calls) && isNum(prev.calls) ? pctChange(cur.calls, prev.calls) : null;
  const profile = input.publicProfile ?? {};
  const notices = input.notices ?? null;
  const competitors = input.competitors ?? [];
  const genreRanks = input.genreRanks ?? [];
  const newOpens = input.newOpens ?? [];
  const access = input.accessRanking ?? null;
  const newReviews7d = input.newReviews7d ?? null;
  const areaLabel = input.areaLabel || access?.area || "設定エリア";
  const shortName = name.replace(/^BISTRO\s+/i, "").trim() || name;

  const missingNote = (label) => `<p class="minor-note">（${esc(label)}：未取得）</p>`;
  const numCell = (v) => `<td class="num">${fmt(v)}</td>`;

  // Hero headline + points (facts only; guesses stay out)
  const defaultTitle = (() => {
    if (isNum(wow) && wow > 0) return ["閲覧は回復。", "次は、口コミと予約導線。"];
    if (isNum(wow) && wow < 0) return ["閲覧は軟調。", "予約導線と口コミを確認。"];
    if (isNum(pvMom) && pvMom > 0) return ["月次の閲覧は堅調。", "次は、口コミと予約導線。"];
    return [name, "今週の確認ポイント"];
  })();
  const heroTitle = (input.heroTitle?.length ? input.heroTitle : defaultTitle).slice(0, 2);

  const defaultPoints = [];
  if (isNum(cur.pv) && isNum(prev.pv)) {
    const weeklyBit = isNum(last7.pv) && isNum(wow)
      ? `直近7日（${shortMd(windows.last7.from)}–${shortMd(windows.last7.to)}）は${fmt(last7.pv)}PVで前7日比${fmtPct(wow)}。`
      : "";
    defaultPoints.push(`${shortMonth(cur.month)}のPVは**${fmt(cur.pv)}**（${shortMonth(prev.month)}${fmt(prev.pv)}から${fmtPct(pvMom)}）。${weeklyBit}`);
  } else {
    defaultPoints.push(`月次PV：未取得。`);
  }
  if (isNum(cur.reservations) || isNum(cur.calls)) {
    const parts = [];
    if (isNum(cur.reservations)) {
      parts.push(isNum(prev.reservations)
        ? `ネット予約は**${fmt(cur.reservations)}組**（${shortMonth(prev.month)}${fmt(prev.reservations)}組）`
        : `ネット予約は**${fmt(cur.reservations)}組**`);
    } else parts.push("ネット予約は未取得");
    if (isNum(cur.calls)) {
      parts.push(isNum(prev.calls)
        ? `予約専用番号の通話成立は**${fmt(cur.calls)}件**（${shortMonth(prev.month)}${fmt(prev.calls)}件）`
        : `予約専用番号の通話成立は**${fmt(cur.calls)}件**`);
    } else parts.push("通話成立は未取得");
    defaultPoints.push(`${parts.join("、")}。`);
  } else {
    defaultPoints.push("ネット予約・通話成立：未取得。");
  }
  {
    const revBit = newReviews7d == null ? "直近7日の新着口コミは未取得" : `直近7日の新着口コミは**${fmt(newReviews7d)}件**`;
    const ratingBit = isNum(profile.rating)
      ? `評価${Number(profile.rating).toFixed(2)}・口コミ${fmt(profile.reviewCount)}件`
      : "評価・口コミ数は未取得";
    const comps = competitors.filter((c) => !c.own && isNum(c.rating));
    const gapBit = comps.length && isNum(profile.rating)
      ? `、上位${comps.length}店（${Math.min(...comps.map((c) => c.rating)).toFixed(2)}–${Math.max(...comps.map((c) => c.rating)).toFixed(2)}）との差は継続`
      : "";
    defaultPoints.push(`${revBit}。${ratingBit}${gapBit}。`);
  }
  const heroPoints = (input.heroPoints?.length ? input.heroPoints : defaultPoints).slice(0, 5);
  const renderPts = (text) => esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  const focusText = input.focusText
    ?? (isNum(cur.calls) && isNum(prev.calls)
      ? `通話成立が ${fmt(prev.calls)}件 → ${fmt(cur.calls)}件 に変化。電話・ネット予約の導線と、来店後に口コミを書いてもらうきっかけ作りを優先します。※通話成立は予約確定を意味しません。`
      : "データがそろい次第、最優先の課題を表示します。");
  // Allow <b>…</b> only around number transitions we generate; escape then re-bold a safe pattern
  const focusHtml = (() => {
    const raw = focusText;
    if (isNum(cur.calls) && isNum(prev.calls) && !input.focusText) {
      return `通話成立が <b>${fmt(prev.calls)}件 → ${fmt(cur.calls)}件</b> に変化。電話・ネット予約の導線と、来店後に口コミを書いてもらうきっかけ作りを優先します。※通話成立は予約確定を意味しません。`;
    }
    return esc(raw);
  })();

  const nextActions = (input.nextActions?.length ? input.nextActions : [
    { title: "口コミのきっかけを作る", body: isNum(profile.reviewCount) ? `会計時のカードや予約後のメッセージで、率直な感想を投稿しやすい案内を用意します。口コミ数（${fmt(profile.reviewCount)}件）を競合と比較し、差があれば埋める導線を確認します。` : "会計時のカードや予約後のメッセージで、率直な感想を投稿しやすい案内を用意します。" },
    { title: "予約導線を見直す", body: isNum(cur.calls) && isNum(prev.calls) ? `PVの動きと通話成立（${fmt(prev.calls)}件→${fmt(cur.calls)}件）を見比べ、店舗ページの予約可能枠・コース掲載・電話受付時間の表記がそろっているか確認します。` : "店舗ページの予約可能枠・コース掲載・電話受付時間の表記がそろっているか確認します。" },
    { title: "ランチの魅力を具体的に見せる", body: profile.budgetDay ? `${esc(profile.budgetDay)}の料理内容・量・雰囲気を写真と説明で伝えます。昼予算の掲載有無はランチ営業の有無を意味しません。` : "昼予算が掲載されている場合、料理内容・量・雰囲気を写真と説明で伝えます。" },
  ]);

  const dailyJson = JSON.stringify(last30.map((d) => ({
    d: `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}`,
    w: weekdayJa(d.date),
    v: d.pv,
    t: peakSet.has(d.date) ? "peak" : dipSet.has(d.date) ? "dip" : "",
  })));

  const competitorsJson = JSON.stringify(competitors.map((c) => ({
    name: c.own ? `${shortName}（自店）` : c.name,
    rating: c.rating ?? null,
    reviews: c.reviews ?? null,
    own: !!c.own,
  })));

  const chartMaxPv = niceMax(Math.max(Number(prev.pv) || 0, Number(cur.pv) || 0));
  const chartMaxRes = niceMax(Math.max(Number(prev.reservations) || 0, Number(cur.reservations) || 0));
  const chartMaxCalls = niceMax(Math.max(Number(prev.calls) || 0, Number(cur.calls) || 0));

  const monthlyJson = JSON.stringify({
    pv: {
      title: isNum(cur.pv) && isNum(pvMom) ? `ページ閲覧数は前月比${Math.abs(pvMom).toFixed(1)}%${pvMom >= 0 ? "増" : "減"}` : (isNum(cur.pv) ? "ページ閲覧数" : "ページ閲覧数（未取得）"),
      subtitle: `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値 / PV`,
      values: [isNum(prev.pv) ? prev.pv : null, isNum(cur.pv) ? cur.pv : null],
      max: chartMaxPv,
      unit: "PV",
      change: fmtPct(pvMom),
      cls: clsDelta(pvMom),
      explain: isNum(cur.pv) && isNum(prev.pv)
        ? `閲覧数の差分は ${cur.pv - prev.pv >= 0 ? "+" : "−"}${fmt(Math.abs(cur.pv - prev.pv))}PV。予約・通話の動きとあわせて導線を確認します。`
        : "月次PVが未取得です。",
    },
    booking: {
      title: isNum(cur.reservations) && isNum(prev.reservations)
        ? `ネット予約は${fmt(prev.reservations)}組から${fmt(cur.reservations)}組へ`
        : (isNum(cur.reservations) ? `ネット予約は${fmt(cur.reservations)}組` : "ネット予約（未取得）"),
      subtitle: `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値 / 組`,
      values: [isNum(prev.reservations) ? prev.reservations : null, isNum(cur.reservations) ? cur.reservations : null],
      max: chartMaxRes,
      unit: "組",
      change: fmtPct(resMom),
      cls: clsDelta(resMom),
      explain: "インターネット予約組数です。来店人数や売上とは異なります。",
    },
    calls: {
      title: isNum(cur.calls) && isNum(prev.calls)
        ? `電話の通話成立は${fmt(prev.calls)}件から${fmt(cur.calls)}件へ`
        : (isNum(cur.calls) ? `電話の通話成立は${fmt(cur.calls)}件` : "通話成立（未取得）"),
      subtitle: `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値 / 件`,
      values: [isNum(prev.calls) ? prev.calls : null, isNum(cur.calls) ? cur.calls : null],
      max: chartMaxCalls,
      unit: "件",
      change: fmtPct(callMom),
      cls: clsDelta(callMom),
      explain: "食べログ予約専用番号の通話成立数です。予約確定数とは異なります。",
    },
  });

  const weeklyFillMax = Math.max(Number(last7.pv) || 0, Number(prior7.pv) || 0, 1);
  const wowDiff = isNum(last7.pv) && isNum(prior7.pv) ? last7.pv - prior7.pv : null;

  const ownComp = competitors.find((c) => c.own);
  const otherComps = competitors.filter((c) => !c.own);
  const lunchOpportunity = (() => {
    const day = profile.budgetDay || ownComp?.budgetDay;
    if (!day) return null;
    const othersWithDay = otherComps.filter((c) => c.budgetDay && c.budgetDay !== "掲載なし");
    return {
      price: day,
      note: othersWithDay.length
        ? `比較店のうち昼予算の掲載がある店舗があります。手頃なランチを具体的に伝える余地があるかは、掲載内容の確認が必要です。`
        : `昼予算の掲載がある比較店が少ない／ない場合でも、「掲載なし」はランチ営業なしを意味しません。`,
    };
  })();

  const competitorInsight = input.competitorInsight ?? (() => {
    if (!otherComps.length || !isNum(profile.rating)) return "競合スナップショット：未取得。";
    const ratings = otherComps.map((c) => c.rating).filter(isNum);
    if (!ratings.length) return `自店の評価は${Number(profile.rating).toFixed(2)}。比較店の評価は未取得。`;
    const lo = Math.min(...ratings).toFixed(2);
    const hi = Math.max(...ratings).toFixed(2);
    const gapLo = (Math.min(...ratings) - Number(profile.rating)).toFixed(2);
    const gapHi = (Math.max(...ratings) - Number(profile.rating)).toFixed(2);
    return `自店の評価は${Number(profile.rating).toFixed(2)}。比較した上位店（${lo}–${hi}）とは${gapLo}–${gapHi}の差があります。`;
  })();

  const reviewNote = input.reviewNote ?? (
    newReviews7d == null
      ? "新着口コミ件数は未取得です。公開ページに投稿日が表示されない場合は、件数と一覧表示から判定し、判定方法と限界を明記してください。"
      : newReviews7d === 0
        ? `確認範囲の新着投稿は ${fmt(0)} 件でした。公開ページに投稿日が表示されない場合は、件数と一覧で判定しています。訪問日・訪問月と投稿日は区別してください。`
        : `確認範囲で新着口コミが ${fmt(newReviews7d)} 件ありました。内容の要約は別途確認してください（本レポートに顧客の氏名・連絡先は記載しません）。`
  );
  const reviewIdea = input.reviewIdea ?? "改善・返信のアイデア：直近の口コミが少ない／ない状態が続く場合は、会計時のカードや予約完了メッセージで「感想を食べログでお聞かせください」と案内する導線を用意する。";

  const peakText = peaks.length
    ? peaks.map((d) => `${mdJa(d.date)} ${fmt(d.pv)}PV`).join("、")
    : "未取得";
  const dipText = dips.length
    ? dips.map((d) => `${mdJa(d.date)} ${fmt(d.pv)}PV`).join("、")
    : "未取得";

  const dailyAxisStart = last30[0] ? `${Number(last30[0].date.slice(5, 7))}/${Number(last30[0].date.slice(8))}` : "";
  const dailyAxisMid = last30[Math.floor(last30.length / 2)]
    ? `${Number(last30[Math.floor(last30.length / 2)].date.slice(5, 7))}/${Number(last30[Math.floor(last30.length / 2)].date.slice(8))}`
    : "";
  const dailyAxisEnd = last30.at(-1)
    ? `${Number(last30.at(-1).date.slice(5, 7))}/${Number(last30.at(-1).date.slice(8))}`
    : "";

  const opensInRange = newOpens.filter((e) => e.within30d);
  const periodLabelPrev = `${shortMd(windows.prior7.from)}–${shortMd(windows.prior7.to)}`;
  const periodLabelLast = `${shortMd(windows.last7.from)}–${shortMd(windows.last7.to)}`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>【食べログ週報】${esc(name)} ${esc(slashDate(asOf))}</title>
  <style>${css}</style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <div class="topline"><span>${esc(name)} · WEEKLY REPORT</span><span class="date">${esc(dotDate(asOf))} / 食べログ</span></div>
      <div class="hero-grid">
        <div>
          <p class="eyebrow">今週のポイント</p>
          <h1>${heroTitle.map((t) => `<span>${esc(t)}</span>`).join("")}</h1>
          <ol class="pts">
            ${heroPoints.map((p) => `<li>${renderPts(p)}</li>`).join("\n            ")}
          </ol>
        </div>
        <aside class="hero-aside" aria-label="最優先の課題">
          <div class="small">FOCUS · まず取り組むこと</div>
          <p>${focusHtml}</p>
        </aside>
      </div>
    </div>
  </header>

  <main class="wrap main">
    <section aria-labelledby="key-numbers">
      <div class="section-heading"><div><div class="section-number">SNAPSHOT</div><h2 id="key-numbers">まず、押さえたい4つの数字</h2></div></div>
      <div class="kpis">
        <article class="kpi">
          <div class="label">${esc(shortMonth(cur.month))}のページ閲覧数</div>
          <div class="value">${fmt(cur.pv)} <span class="unit">PV</span></div>
          <div class="delta ${clsDelta(pvMom)}">${isNum(pvMom) ? deltaArrow(pvMom) : NA}</div>
          <p class="note">${isNum(prev.pv) ? `${esc(shortMonth(prev.month))} ${fmt(prev.pv)} PV` : "前月：未取得"}</p>
        </article>
        <article class="kpi">
          <div class="label">${esc(shortMonth(cur.month))}のネット予約</div>
          <div class="value">${fmt(cur.reservations)} <span class="unit">組</span></div>
          <div class="delta ${clsDelta(resMom)}">${isNum(resMom) ? deltaArrow(resMom) : NA}</div>
          <p class="note">${isNum(prev.reservations) ? `${esc(shortMonth(prev.month))} ${fmt(prev.reservations)}組` : "前月：未取得"}</p>
        </article>
        <article class="kpi">
          <div class="label">${esc(shortMonth(cur.month))}の電話通話成立</div>
          <div class="value">${fmt(cur.calls)} <span class="unit">件</span></div>
          <div class="delta ${clsDelta(callMom)}">${isNum(callMom) ? deltaArrow(callMom) : NA}</div>
          <p class="note">${isNum(prev.calls) ? `${esc(shortMonth(prev.month))} ${fmt(prev.calls)}件／予約確定件数ではありません` : "予約確定件数ではありません／前月：未取得"}</p>
        </article>
        <article class="kpi">
          <div class="label">直近7日の新着口コミ</div>
          <div class="value">${fmt(newReviews7d)} <span class="unit">件</span></div>
          <div class="delta neutral">${esc(periodLabelLast)}</div>
          <p class="note">累計${fmt(profile.reviewCount)}${isNum(profile.reviewCount) ? "件" : ""}</p>
        </article>
      </div>
    </section>

    <section aria-labelledby="trend-heading" class="section-block">
      <div class="section-heading"><div><div class="section-number">01 / STORE ADMIN</div><h2 id="trend-heading">店舗管理データ：閲覧と予約の動き</h2><p>見たい指標を選ぶと、月次グラフが切り替わります。</p></div></div>
      <div class="panels">
        <article class="panel">
          <div class="panel-top"><div><h3 id="monthly-title">月次比較</h3><p class="panel-sub" id="monthly-subtitle">${esc(monthLabel(prev.month))}・${esc(monthLabel(cur.month))}の確定値</p></div><span class="badge">月次比較</span></div>
          <div class="segmented" role="group" aria-label="月次グラフの指標">
            <button type="button" data-metric="pv" aria-pressed="true">閲覧数</button>
            <button type="button" data-metric="booking" aria-pressed="false">ネット予約</button>
            <button type="button" data-metric="calls" aria-pressed="false">電話通話</button>
          </div>
          <div class="chart-area" role="img" aria-labelledby="monthly-title" aria-describedby="monthly-alt">
            <div class="axis-line" style="top:20px"><span id="axis-max">${fmt(chartMaxPv)}</span></div>
            <div class="axis-line" style="top:calc(50% + 10px)"><span id="axis-half">${fmt(chartMaxPv / 2)}</span></div>
            <div class="axis-line" style="bottom:0"><span>0</span></div>
            <div class="bars" id="monthly-bars">
              <div class="bar-col" data-period="${esc(shortMonth(prev.month))}" style="--bar-h:${fillPct(prev.pv, chartMaxPv)}"><span class="bar-label">${fmt(prev.pv)}</span><div class="bar" tabindex="0" title="${esc(shortMonth(prev.month))}：${fmt(prev.pv)} PV" aria-label="${esc(shortMonth(prev.month))}：${fmt(prev.pv)} PV"></div></div>
              <div class="bar-col" data-period="${esc(shortMonth(cur.month))}" style="--bar-h:${fillPct(cur.pv, chartMaxPv)}"><span class="bar-label">${fmt(cur.pv)}</span><div class="bar current" tabindex="0" title="${esc(shortMonth(cur.month))}：${fmt(cur.pv)} PV" aria-label="${esc(shortMonth(cur.month))}：${fmt(cur.pv)} PV"></div></div>
            </div>
          </div>
          <p class="chart-caption"><strong id="monthly-change" class="${clsDelta(pvMom)}">${fmtPct(pvMom)}</strong><span id="monthly-explain">月次の閲覧・予約・通話を切り替えで確認できます。</span></p>
          <p class="minor-note" id="monthly-alt">${esc(shortMonth(prev.month))} ${fmt(prev.pv)} PV、${esc(shortMonth(cur.month))} ${fmt(cur.pv)} PV。</p>
          <div class="tbl-wrap"><table class="data">
            <caption>表1 月次比較（出典：店舗管理画面「来店指標（TEL数・ネット予約数など）」月別／単位：PV・件・組）</caption>
            <thead><tr><th>指標</th><th class="num">${esc(monthLabel(prev.month))}</th><th class="num">${esc(monthLabel(cur.month))}</th><th class="num">増減</th><th class="num">前月比</th></tr></thead>
            <tbody>
              <tr><td>アクセス数（PV）</td>${numCell(prev.pv)}${numCell(cur.pv)}<td class="num">${isNum(cur.pv) && isNum(prev.pv) ? `${cur.pv - prev.pv >= 0 ? "+" : "−"}${fmt(Math.abs(cur.pv - prev.pv))}` : NA}</td><td class="num">${fmtPct(pvMom)}</td></tr>
              <tr><td>食べログ予約専用番号 通話成立数（件）</td>${numCell(prev.calls)}${numCell(cur.calls)}<td class="num">${isNum(cur.calls) && isNum(prev.calls) ? `${cur.calls - prev.calls >= 0 ? "+" : "−"}${fmt(Math.abs(cur.calls - prev.calls))}` : NA}</td><td class="num">${fmtPct(callMom)}</td></tr>
              <tr><td>インターネット予約組数（組）</td>${numCell(prev.reservations)}${numCell(cur.reservations)}<td class="num">${isNum(cur.reservations) && isNum(prev.reservations) ? `${cur.reservations - prev.reservations >= 0 ? "+" : "−"}${fmt(Math.abs(cur.reservations - prev.reservations))}` : NA}</td><td class="num">${fmtPct(resMom)}</td></tr>
              <tr><td>PV内訳 PC／スマートフォン／アプリ</td><td class="num">${isNum(prev.pvPc) || isNum(prev.pvSp) || isNum(prev.pvApp) ? `${fmt(prev.pvPc)}／${fmt(prev.pvSp)}／${fmt(prev.pvApp)}` : NA}</td><td class="num">${isNum(cur.pvPc) || isNum(cur.pvSp) || isNum(cur.pvApp) ? `${fmt(cur.pvPc)}／${fmt(cur.pvSp)}／${fmt(cur.pvApp)}` : NA}</td><td class="num">—</td><td class="num">—</td></tr>
            </tbody>
          </table></div>
        </article>
        <article class="panel">
          <div class="panel-top"><div><h3>直近7日の閲覧数${isNum(wow) && wow > 0 ? "は増加" : isNum(wow) && wow < 0 ? "は減少" : ""}</h3><p class="panel-sub">${esc(periodLabelPrev)} と ${esc(periodLabelLast)} / PV</p></div><span class="badge">週次比較</span></div>
          <div class="weekly-big">${fmt(last7.pv)}<span>PV / 直近7日</span></div>
          <div class="weekly-change">${isNum(wowDiff) && isNum(wow)
            ? `${wowDiff >= 0 ? "↗" : "↘"} 前の7日間より ${fmt(Math.abs(wowDiff))} PV（${Math.abs(wow).toFixed(1)}%）${wowDiff >= 0 ? "増" : "減"}`
            : "前週比較：未取得"}</div>
          <div class="weekly-rows" role="img" aria-label="前の7日間（${esc(periodLabelPrev)}）${fmt(prior7.pv)} PV、直近7日間（${esc(periodLabelLast)}）${fmt(last7.pv)} PV。">
            <div class="weekly-row"><div class="row-label"><span>前の7日間（${esc(periodLabelPrev)}）</span><b>${fmt(prior7.pv)}</b></div><div class="track"><div class="fill" style="--fill:${fillPct(prior7.pv, weeklyFillMax)}"></div></div></div>
            <div class="weekly-row"><div class="row-label"><span>直近7日間（${esc(periodLabelLast)}）</span><b>${fmt(last7.pv)}</b></div><div class="track"><div class="fill current" style="--fill:${fillPct(last7.pv, weeklyFillMax)}"></div></div></div>
          </div>
          <p class="minor-note">出典：店舗管理画面 アクセス数レポート（日別）。${esc(slashDate(asOf))}は集計中のため含めていません（0扱いにはしていません）。直近末日の値は速報値の可能性があり、後日修正される場合があります。${prior7.missingDates?.length || last7.missingDates?.length ? " ※日別PVに欠けあり。" : ""}</p>
          <div class="tbl-wrap"><table class="data">
            <caption>表2 予約通知（出典：店舗管理画面トップ「新着ご予約情報」／${esc(slashDate(asOf))} 確認時点／単位：件）</caption>
            <thead><tr><th>区分</th><th class="num">通知件数</th></tr></thead>
            <tbody>
              ${notices ? `<tr><td>新規予約</td>${numCell(notices.new)}</tr><tr><td>予約内容の変更</td>${numCell(notices.changed)}</tr><tr><td>キャンセル</td>${numCell(notices.cancelled)}</tr>`
                : `<tr><td>新規予約</td><td class="num">未取得</td></tr><tr><td>予約内容の変更</td><td class="num">未取得</td></tr><tr><td>キャンセル</td><td class="num">未取得</td></tr>`}
            </tbody>
          </table></div>
          <p class="minor-note">※確認時点で表示されていた新着通知の件数です。週・月の予約総数やキャンセル総数ではありません。顧客の氏名・連絡先は記載しません。</p>
        </article>
      </div>

      <article class="panel" style="margin-top:18px">
        <div class="panel-top"><div><h3 id="daily-title">直近30日の日別PV（${esc(slashDate(windows.last30.from))}–${esc(slashDate(windows.last30.to))}）</h3><p class="panel-sub">合計 ${fmt(last30.length ? sum30 : null)} PV／1日平均 ${avg30 != null ? avg30.toFixed(1) : NA} PV／出典：アクセス数レポート（日別）</p></div><span class="badge">30日推移</span></div>
        ${last30.length ? `<div class="daily" id="daily-bars" role="group" aria-label="日別PVの棒グラフ。各棒にフォーカスすると値を表示します。"></div>
        <div class="daily-axis"><span>${esc(dailyAxisStart)}</span><span>${esc(dailyAxisMid)}</span><span>${esc(dailyAxisEnd)}</span></div>
        <div class="legend"><span><i style="background:var(--green-2)"></i>ピーク上位4日</span><span><i style="background:var(--orange)"></i>落ち込み下位4日</span><span><i style="background:#b6d0c4"></i>その他</span></div>
        <div id="daily-readout" aria-live="polite">棒にカーソルを合わせるか、Tabキーで選択すると値を表示します。</div>
        <div class="hl">
          <div><b>ピーク</b>${esc(peakText)}</div>
          <div class="dip"><b>落ち込み</b>${esc(dipText)}</div>
        </div>
        <details><summary>日別データ表を開く（${last30.length}日分）</summary>
          <div class="tbl-wrap"><table class="data"><caption>表3 日別アクセス数（出典：店舗管理画面 アクセス数レポート／単位：PV／${esc(slashDate(asOf))}は集計中のため除外）</caption>
          <thead><tr><th>日付</th><th class="num">PV</th><th>区分</th></tr></thead>
          <tbody>${last30.map((d) => `<tr><td>${esc(slashDate(d.date))}（${weekdayJa(d.date)}）</td><td class="num">${fmt(d.pv)}</td><td>${peakSet.has(d.date) ? "ピーク" : dipSet.has(d.date) ? "落ち込み" : ""}</td></tr>`).join("")}</tbody>
          </table></div>
        </details>` : missingNote("日別PV")}
      </article>
    </section>

    <section aria-labelledby="review-heading" class="section-block">
      <div class="section-heading"><div><div class="section-number">02 / RATING &amp; REVIEWS</div><h2 id="review-heading">自店の評価と新着口コミ</h2></div></div>
      <div class="two-col">
        <article class="panel">
          <h3>評価・口コミ・保存数</h3>
          <div class="tbl-wrap"><table class="data">
            <caption>表4 公開店舗ページの指標（出典：食べログ公開店舗ページ／${esc(slashDate(asOf))} 取得）</caption>
            <thead><tr><th>指標</th><th class="num">値</th><th>単位</th></tr></thead>
            <tbody>
              <tr><td>評価</td><td class="num">${isNum(profile.rating) ? Number(profile.rating).toFixed(2) : NA}</td><td>点（5点満点）</td></tr>
              <tr><td>口コミ数</td>${numCell(profile.reviewCount)}<td>件</td></tr>
              <tr><td>保存数</td>${numCell(profile.saveCount)}<td>人</td></tr>
              <tr><td>予算（夜／昼）</td><td class="num">${profile.budgetNight || profile.budgetDay ? `${yen(profile.budgetNight)}／${yen(profile.budgetDay)}` : NA}</td><td>円</td></tr>
            </tbody>
          </table></div>
        </article>
        <article class="panel">
          <h3>直近7日の新着口コミ</h3>
          <p class="panel-sub">確認範囲：${esc(slashDate(windows.last7.from))}–${esc(slashDate(asOf))}</p>
          <div class="review-stat"><strong>${newReviews7d == null ? "未取得" : newReviews7d === 0 ? "該当口コミなし" : `${fmt(newReviews7d)}件`}</strong></div>
          <p class="review-note">${esc(reviewNote)}</p>
          <p class="minor-note">${esc(reviewIdea)}</p>
        </article>
      </div>
    </section>

    <section aria-labelledby="position-heading" class="section-block">
      <div class="section-heading"><div><div class="section-number">03 / COMPETITORS</div><h2 id="position-heading">競合比較（評価上位店）</h2><p>評価と口コミ件数を切り替えて確認できます。</p></div></div>
      <div class="two-col">
        <article class="panel">
          <div class="panel-top"><div><h3 id="rank-title">評価比較</h3><p class="panel-sub" id="rank-subtitle">${esc(areaLabel)} / ${esc(slashDate(asOf))}時点 / 5点満点</p></div></div>
          <div class="segmented" role="group" aria-label="競合比較の指標">
            <button type="button" data-rank="rating" aria-pressed="true">評価</button>
            <button type="button" data-rank="reviews" aria-pressed="false">口コミ数</button>
          </div>
          <div class="competitor-rows" id="competitor-rows" role="img" aria-labelledby="rank-title" aria-describedby="rank-alt"></div>
          <p class="insight-box" id="rank-insight"><strong>読み取り：</strong>${esc(competitorInsight)}</p>
          <p class="minor-note" id="rank-alt">${competitors.length ? "" : "競合データ：未取得"}</p>
        </article>
        <article class="panel">
          <h3>${lunchOpportunity ? "強み・価格帯の確認" : "価格帯の確認"}</h3>
          <p class="panel-sub">公開ページに掲載された予算で比較</p>
          ${lunchOpportunity ? `<div class="opportunity">
            <div class="tag">${esc(shortName)} のランチ予算</div>
            <div class="price">${esc(lunchOpportunity.price)}</div>
            <p>${esc(lunchOpportunity.note)}</p>
          </div>` : missingNote("昼予算")}
          <ul class="minor-note">
            <li><b>価格：</b>夜 ${profile.budgetNight ? yen(profile.budgetNight) : "未取得"} ／ 昼 ${profile.budgetDay ? yen(profile.budgetDay) : "未取得"}。「昼予算 掲載なし」はランチ営業の有無を意味しません。</li>
            <li><b>評価：</b>${isNum(profile.rating) ? Number(profile.rating).toFixed(2) : "未取得"}${otherComps.filter((c) => isNum(c.rating)).length ? ` ／ 比較店 ${Math.min(...otherComps.filter((c) => isNum(c.rating)).map((c) => c.rating)).toFixed(2)}–${Math.max(...otherComps.filter((c) => isNum(c.rating)).map((c) => c.rating)).toFixed(2)}` : " ／ 比較店：未取得"}</li>
            <li><b>口コミ数：</b>${fmt(profile.reviewCount)}${otherComps.filter((c) => isNum(c.reviews)).length ? ` ／ 比較店 ${fmt(Math.min(...otherComps.filter((c) => isNum(c.reviews)).map((c) => c.reviews)))}–${fmt(Math.max(...otherComps.filter((c) => isNum(c.reviews)).map((c) => c.reviews)))}` : " ／ 比較店：未取得"}</li>
          </ul>
        </article>
      </div>
      <article class="panel">
        ${competitors.length ? `<div class="tbl-wrap"><table class="data">
          <caption>表5 競合比較（出典：公開ランキング一覧および各店公開ページ／${esc(slashDate(asOf))} 取得／評価は点、口コミは件、保存は人、予算は円）</caption>
          <thead><tr><th>#</th><th>店名</th><th class="num">評価</th><th class="num">口コミ</th><th>夜予算</th><th>昼予算</th><th>最寄駅</th><th class="num">保存</th></tr></thead>
          <tbody>
            ${competitors.map((c, i) => `<tr${c.own ? ' class="own"' : ""}><td>${c.own ? "—" : i + 1}</td><td>${esc(c.name)}${c.own ? "（自店）" : ""}</td><td class="num">${isNum(c.rating) ? Number(c.rating).toFixed(2) : NA}</td><td class="num">${fmt(c.reviews)}</td><td>${yen(c.budgetNight)}</td><td>${yen(c.budgetDay)}</td><td>${esc(c.station ?? NA)}</td><td class="num">${fmt(c.saveCount)}</td></tr>`).join("")}
          </tbody>
        </table></div>
        <p class="insight-box"><strong>最近の変化：</strong>${esc(input.competitorChangeNote || "前回スナップショットが無い項目は、価格変更の有無を推定していません。「昼予算 掲載なし」は公開ページに記載がないことを示します。")}</p>`
        : missingNote("競合詳細")}
      </article>
    </section>

    <section aria-labelledby="new-heading" class="section-block">
      <div class="section-heading"><div><div class="section-number">04 / AREA</div><h2 id="new-heading">エリアの新規オープンとランキング</h2></div></div>
      <div class="panels">
        <article class="panel">
          <h3>直近30日の新規オープン・新規掲載</h3>
          <p class="panel-sub">確認範囲：オープン日 ${esc(slashDate(windows.last30.from))}–${esc(slashDate(asOf))}</p>
          <div class="review-stat"><strong>${newOpens.length ? (opensInRange.length ? `${opensInRange.length}件` : "該当なし") : "未取得"}</strong></div>
          ${newOpens.length ? `<div class="tbl-wrap"><table class="data">
            <caption>表6 ニューオープン順の店舗（出典：公開ニューオープン順一覧と各店ページのオープン日／${esc(slashDate(asOf))} 取得）</caption>
            <thead><tr><th>エリア</th><th>店名（ジャンル）</th><th>オープン日</th><th>30日以内</th></tr></thead>
            <tbody>
              ${newOpens.slice(0, 12).map((e) => `<tr><td>${esc(e.areaLabel ?? "")}</td><td>${esc(e.name)}${e.genreLabel ? `（${esc(e.genreLabel)}）` : ""}</td><td>${e.openedOn ? esc(slashDate(e.openedOn)) : "確認不可"}</td><td>${e.openedOn == null ? "判定不可" : e.within30d ? "対象" : "対象外"}</td></tr>`).join("")}
            </tbody>
          </table></div>
          <p class="minor-note">オープン日が確認できない店舗は新規掲載と推定していません。オープン日と掲載開始日は別です。</p>`
            : missingNote("ニューオープン一覧")}
        </article>
        <article class="panel">
          <h3>自店のエリア内順位</h3>
          <p class="panel-sub">${esc(areaLabel)}</p>
          <div class="tbl-wrap"><table class="data">
            <caption>表7 エリア順位（出典：店舗管理画面「アクセス数ランキング」、公開ランキング一覧（評価順）／${esc(slashDate(asOf))} 取得／単位：位）</caption>
            <thead><tr><th>ランキング</th><th class="num">順位</th><th>備考</th></tr></thead>
            <tbody>
              <tr><td>アクセス数ランキング</td><td class="num">${access?.self?.rank != null ? fmt(access.self.rank) : NA}</td><td>${access?.self?.pv != null ? `${fmt(access.self.pv)}PV` : "未取得"}${access?.momPct != null ? `、前月比${fmtPct(access.momPct)}` : ""}</td></tr>
              ${genreRanks.length
                ? genreRanks.map((g) => `<tr><td>${esc(g.label)}</td><td class="num">${g.rank != null ? fmt(g.rank) : NA}</td><td>${esc(g.note ?? "広告枠を除く掲載順")}</td></tr>`).join("")
                : `<tr><td>ジャンル公開順位</td><td class="num">未取得</td><td>広告枠を除く掲載順</td></tr>`}
            </tbody>
          </table></div>
          ${access?.competitorsNote ? `<p class="minor-note">${esc(access.competitorsNote)}</p>` : `<p class="minor-note">アクセス数の順位と評価順の順位は別の指標です。広告枠の扱いと対象エリアを明記してください。</p>`}
        </article>
      </div>
    </section>

    <section aria-labelledby="action-heading">
      <div class="section-heading"><div><div class="section-number">NEXT ACTIONS</div><h2 id="action-heading">次に取り組む3つのこと</h2><p>実行しやすい順にまとめました。</p></div></div>
      <div class="action-grid">
        ${nextActions.slice(0, 3).map((a, i) => `<article class="action"><span class="action-no">0${i + 1}</span><h3>${esc(a.title)}</h3><p>${esc(a.body)}</p></article>`).join("")}
      </div>
    </section>

    <aside class="footnote" aria-label="データの見方">
      <strong>数字の見方</strong>
      <ul>
        <li>月次・週次・日別・確認時点のデータは対象期間が異なるため、同じ集計として扱いません。</li>
        <li>電話の「通話成立」は予約完了を意味しません。未取得の項目は空欄やゼロにせず「未取得」と記載します。</li>
        <li>予約通知の件数は確認時点の新着通知数で、期間合計ではありません。</li>
        <li>口コミの投稿日を確認できない場合は、判定方法と限界を明記します。顧客の氏名・連絡先は記載しません。</li>
        <li>グラフの切り替えはこのファイル内の表示だけに作用し、外部への通信は行いません。</li>
      </ul>
    </aside>
    <footer class="footer"><span>${esc(name)} · 食べログ週報 · 作成日 ${esc(slashDate(asOf))}（Asia/Tokyo）</span><span>出典：食べログ店舗管理画面・公開ページ${input.storeKey ? ` · 店舗ID ${esc(input.storeKey)}` : ""}</span></footer>
  </main>

  <script>
    (() => {
      const monthly = ${monthlyJson};
      const periods = [${JSON.stringify(shortMonth(prev.month))}, ${JSON.stringify(shortMonth(cur.month))}];
      const competitors = ${competitorsJson};
      const daily = ${dailyJson};
      const areaLabel = ${JSON.stringify(areaLabel)};
      const asOfLabel = ${JSON.stringify(slashDate(asOf))};
      const format = value => (value == null || !Number.isFinite(Number(value)) ? '未取得' : Number(value).toLocaleString('ja-JP'));
      const byId = id => document.getElementById(id);
      const nice = (v) => {
        const n = Number(v) || 0;
        if (n <= 0) return 1;
        const exp = Math.pow(10, Math.floor(Math.log10(n)));
        return Math.ceil(n / exp) * exp;
      };

      function renderMonthly(key) {
        const d = monthly[key]; if (!d || !byId('monthly-title')) return;
        byId('monthly-title').textContent = d.title;
        byId('monthly-subtitle').textContent = d.subtitle;
        const max = d.max || nice(Math.max(d.values[0] || 0, d.values[1] || 0));
        byId('axis-max').textContent = format(max);
        byId('axis-half').textContent = format(max / 2);
        byId('monthly-change').textContent = d.change;
        byId('monthly-change').className = d.cls;
        byId('monthly-explain').textContent = d.explain;
        const cols = byId('monthly-bars').children;
        d.values.forEach((value, index) => {
          const h = value == null ? 0 : (value / max * 100);
          cols[index].style.setProperty('--bar-h', Math.max(value == null ? 0 : 5, h) + '%');
          cols[index].querySelector('.bar-label').textContent = format(value);
          const bar = cols[index].querySelector('.bar');
          bar.title = periods[index] + '：' + format(value) + ' ' + d.unit;
          bar.setAttribute('aria-label', bar.title);
        });
        byId('monthly-alt').textContent = periods[0] + ' ' + format(d.values[0]) + ' ' + d.unit + '、' + periods[1] + ' ' + format(d.values[1]) + ' ' + d.unit + '。グラフの縦軸は0から' + format(max) + ' ' + d.unit + 'です。';
        document.querySelectorAll('[data-metric]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.metric === key)));
      }

      function renderRank(key) {
        const isRating = key === 'rating';
        if (!byId('rank-title')) return;
        const usable = competitors.filter(c => c[key] != null && Number.isFinite(Number(c[key])));
        byId('rank-title').textContent = isRating ? '評価は競合上位店と比較' : '口コミ件数は競合上位店と比較';
        byId('rank-subtitle').textContent = areaLabel + ' / ' + asOfLabel + '時点 / ' + (isRating ? '5点満点' : '件数');
        const list = byId('competitor-rows'); list.replaceChildren();
        if (!usable.length) {
          byId('rank-insight').innerHTML = '<strong>読み取り：</strong>競合データ未取得';
          byId('rank-alt').textContent = '競合データ：未取得';
          document.querySelectorAll('[data-rank]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rank === key)));
          return;
        }
        const sorted = [...usable].sort((a, b) => Number(b[key]) - Number(a[key]));
        const max = isRating ? 5 : Math.max(...sorted.map(i => Number(i.reviews) || 0), 1);
        sorted.forEach(item => {
          const row = document.createElement('div');
          row.className = 'competitor-row' + (item.own ? ' own' : '');
          const name = document.createElement('span'); name.className = 'competitor-name'; name.textContent = item.name; name.title = item.name;
          const track = document.createElement('div'); track.className = 'rank-track';
          const bar = document.createElement('span'); bar.className = 'rank-bar';
          bar.style.setProperty('--rank-w', ((Number(item[key]) || 0) / max * 100) + '%');
          track.append(bar);
          const value = document.createElement('span'); value.className = 'rank-value';
          value.textContent = isRating ? Number(item.rating).toFixed(2) : format(item.reviews);
          row.append(name, track, value); list.append(row);
        });
        const own = sorted.find(i => i.own);
        byId('rank-insight').innerHTML = isRating
          ? '<strong>読み取り：</strong>' + (own ? ('自店の評価は' + Number(own.rating).toFixed(2) + '。') : '') + '棒は0から5点を基準にしています。'
          : '<strong>読み取り：</strong>' + (own ? ('自店は' + format(own.reviews) + '件。') : '') + '棒は件数に比例します。';
        byId('rank-alt').textContent = sorted.map(i => i.name + ' ' + (isRating ? Number(i.rating).toFixed(2) + '点' : format(i.reviews) + '件')).join('、') + '。';
        document.querySelectorAll('[data-rank]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rank === key)));
      }

      function renderDaily() {
        const box = byId('daily-bars'); const out = byId('daily-readout'); if (!box || !daily.length) return;
        const max = Math.max(...daily.map(d => d.v), 1);
        daily.forEach(d => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'dbar' + (d.t ? ' ' + d.t : '');
          b.style.setProperty('--h', (d.v / max * 100) + '%');
          const text = d.d + '（' + d.w + '）：' + format(d.v) + ' PV' + (d.t === 'peak' ? '（ピーク）' : d.t === 'dip' ? '（落ち込み）' : '');
          b.title = text; b.setAttribute('aria-label', text);
          const show = () => { out.textContent = text; };
          b.addEventListener('mouseenter', show); b.addEventListener('focus', show); b.addEventListener('click', show);
          box.append(b);
        });
      }

      document.querySelectorAll('[data-metric]').forEach(b => b.addEventListener('click', () => renderMonthly(b.dataset.metric)));
      document.querySelectorAll('[data-rank]').forEach(b => b.addEventListener('click', () => renderRank(b.dataset.rank)));
      renderMonthly('pv');
      renderRank('rating');
      renderDaily();
    })();
  </script>
</body>
</html>`;
}

/** DB/ツール結果から週報入力を組み立てる（足りない節は空→「未取得」） */
export function assembleWeeklyReportInput({
  storeKey, storeName, asOf, monthlyRows = [], dailyRows = [], reviews = null,
  publicProfile = null, notices = null, accessRanking = null,
  competitors = [], genreRanks = [], newOpens = [], nextActions,
  heroTitle, heroPoints, focusText, areaLabel, competitorInsight, competitorChangeNote,
  reviewNote, reviewIdea,
}) {
  const months = [...monthlyRows].filter((m) => m.month).sort((a, b) => a.month.localeCompare(b.month));
  const curMonth = asOf.slice(0, 7);
  // 直近の確定月（当月より前）と、その前月
  const complete = months.filter((m) => m.month < curMonth);
  const cur = complete.at(-1) ?? months.at(-1) ?? null;
  const prev = cur ? complete.filter((m) => m.month < cur.month).at(-1) ?? null : null;
  const windows = weeklyPvWindows(asOf);
  const newReviews7d = Array.isArray(reviews)
    ? reviews.filter((r) => {
      const d = r.postedAt ?? r.review_date ?? r.date;
      return d && d >= windows.last7.from && d <= windows.last7.to;
    }).length
    : null; // reviews 未渡し = 未取得（空配列は0件）
  return {
    storeKey, storeName, asOf,
    monthly: {
      prev: prev ? { month: prev.month, pv: prev.pv, reservations: prev.reservations ?? prev.netReservations, calls: prev.calls, pvPc: prev.pvPc, pvSp: prev.pvSp, pvApp: prev.pvApp } : {},
      cur: cur ? { month: cur.month, pv: cur.pv, reservations: cur.reservations ?? cur.netReservations, calls: cur.calls, pvPc: cur.pvPc, pvSp: cur.pvSp, pvApp: cur.pvApp } : {},
    },
    daily: dailyRows,
    publicProfile: publicProfile ?? {},
    notices,
    newReviews7d,
    accessRanking,
    competitors,
    genreRanks,
    newOpens: (newOpens ?? []).map((e) => ({ ...e, within30d: e.within30d ?? within30Days(e.openedOn, asOf) })),
    nextActions,
    heroTitle, heroPoints, focusText, areaLabel, competitorInsight, competitorChangeNote,
    reviewNote, reviewIdea,
  };
}

export { weeklyPvWindows, sumDailyPv, pctChange, shiftDate, within30Days };
