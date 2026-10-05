// 全サイト共通の週報 HTML テンプレート（オフライン。外部リソースなし）。
// UI はユーザー承認済みのサンプル週報（PR #38 / #40）: hero / FOCUS / KPI カード / panels / chart-area /
// 日別バー / 評価・口コミ / competitor bars / action-grid / footnote。食べログ・一休・（今後）ホットペッパー等はすべてこの見た目。
// 内容ルール（青写真）: 未取得は空欄や 0 にせず「未取得」、事実と推測（（推測））を分ける、顧客の氏名・連絡先（PII）は載せない。
// サイト固有の数値・文言は各サイトのアダプタ（scripts/tabelog/weekly-report.js、scripts/ikyu/weekly-report.js）が
// 「ビュー」（下の renderWeeklyReportHtml の引数）に詰める。この層は並べて描くだけで、サイト固有の判断はしない。
// 詳細: docs/weekly-report.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pctChange, shiftDate, sumDailyPv, weeklyPvWindows, within30Days } from "./weekly-windows.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
export const loadWeeklyCss = () => fs.readFileSync(path.join(__dir, "weekly-report.css.txt"), "utf8");

// ---------- 共通の表示ヘルパー（各サイトのアダプタも使う） ----------
export const NA = "未取得";
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const isNum = (n) => n != null && n !== "" && Number.isFinite(Number(n));
export const fmt = (n) => (isNum(n) ? Number(n).toLocaleString("ja-JP") : NA);
export const fmtPct = (n) => {
  if (n == null || !Number.isFinite(n)) return NA;
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
};
export const fmtDiff = (cur, prev) => (isNum(cur) && isNum(prev)
  ? `${cur - prev >= 0 ? "+" : "−"}${fmt(Math.abs(cur - prev))}`
  : NA);
export const clsDelta = (n) => (n == null || !Number.isFinite(n) ? "neutral" : n > 0 ? "positive" : n < 0 ? "negative" : "neutral");
export const deltaArrow = (n) => {
  if (n == null || !Number.isFinite(n)) return "";
  if (n > 0) return `↑ 前月比 ${Math.abs(n).toFixed(1)}%増`;
  if (n < 0) return `↓ 前月比 ${Math.abs(n).toFixed(1)}%減`;
  return "前月比 変化なし";
};
export const niceMax = (v) => {
  const n = Number(v) || 0;
  if (n <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(n));
  return Math.ceil((n * 1.15) / exp) * exp;
};
export const monthLabel = (ym) => {
  if (!ym) return NA;
  const [y, m] = ym.split("-");
  return `${Number(y)}年${Number(m)}月`;
};
export const shortMonth = (ym) => (ym ? `${Number(ym.slice(5))}月` : NA);
export const slashDate = (ymd) => (ymd ? ymd.replace(/-/g, "/") : NA);
export const dotDate = (ymd) => (ymd ? ymd.replace(/-/g, ".") : NA);
export const shortMd = (ymd) => (ymd ? `${ymd.slice(5, 7)}/${ymd.slice(8)}` : "");
export const weekdayJa = (date) => ["日", "月", "火", "水", "木", "金", "土"][new Date(`${date}T00:00:00Z`).getUTCDay()];
export const mdJa = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}（${weekdayJa(ymd)}）` : NA);
const mdNum = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}`;
export const fillPct = (value, max) => {
  if (!isNum(value) || !isNum(max) || max <= 0) return "0%";
  return `${Math.max(0, Math.min(100, (Number(value) / Number(max)) * 100))}%`;
};
/** 前月比（%）。どちらかが未取得なら null（＝「未取得」表示） */
export const mom = (cur, prev) => (isNum(cur) && isNum(prev) ? pctChange(Number(cur), Number(prev)) : null);
/** 本文中の **太字** だけを許可（それ以外はエスケープ） */
export const renderMd = (text, tag = "strong") => esc(text).replace(/\*\*(.+?)\*\*/g, `<${tag}>$1</${tag}>`);

/**
 * 月次行（{ month: 'YYYY-MM', ... }）から、当月より前の直近確定月（cur）とその前月（prev）を選ぶ。
 * consecutive=true なら prev は cur の暦上の前月に限る（欠けた月をまたいで「前月比」と書かない）。
 */
export function pickMonthPair(rows, asOf, { consecutive = false, isComplete = () => true } = {}) {
  const months = [...(rows ?? [])].filter((m) => m?.month).sort((a, b) => a.month.localeCompare(b.month));
  const curMonth = asOf.slice(0, 7);
  const complete = months.filter((m) => m.month < curMonth && isComplete(m));
  const cur = complete.at(-1) ?? (consecutive ? null : months.at(-1)) ?? null;
  if (!cur) return { cur: null, prev: null };
  let prev = complete.filter((m) => m.month < cur.month).at(-1) ?? null;
  if (consecutive && prev) {
    const d = new Date(`${cur.month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    if (prev.month !== d.toISOString().slice(0, 7)) prev = null;
  }
  return { cur, prev };
}

// ---------- 部品 ----------
const missingNote = (label) => `<p class="minor-note">（${esc(label)}：未取得）</p>`;

/** table = { caption, head: [{ label, num }], rows: [{ cls, cells: [{ text, num } | string] }] } */
export function renderTable(table) {
  if (!table) return "";
  const cell = (c, tag) => {
    const o = typeof c === "object" && c !== null ? c : { text: c };
    return `<${tag}${o.num ? ' class="num"' : ""}>${esc(o.text ?? NA)}</${tag}>`;
  };
  return `<div class="tbl-wrap"><table class="data">
            <caption>${esc(table.caption)}</caption>
            <thead><tr>${table.head.map((h) => cell(h.label != null ? { text: h.label, num: h.num } : h, "th")).join("")}</tr></thead>
            <tbody>
              ${table.rows.map((r) => `<tr${r.cls ? ` class="${esc(r.cls)}"` : ""}>${r.cells.map((c) => cell(c, "td")).join("")}</tr>`).join("")}
            </tbody>
          </table></div>`;
}

/** panel = { title, sub, stat, table, notes: [string], missing } — 汎用パネル（04 など） */
function renderPanel(p) {
  if (!p) return "";
  return `<article class="panel">
          <h3>${esc(p.title)}</h3>
          ${p.sub ? `<p class="panel-sub">${esc(p.sub)}</p>` : ""}
          ${p.stat != null ? `<div class="review-stat"><strong>${esc(p.stat)}</strong></div>` : ""}
          ${p.table ? renderTable(p.table) : ""}
          ${(p.notes ?? []).map((n) => `<p class="minor-note">${esc(n)}</p>`).join("")}
          ${p.missing ? missingNote(p.missing) : ""}
        </article>`;
}

const heading = (h, id) => `<div class="section-heading"><div><div class="section-number">${esc(h.number)}</div><h2 id="${id}">${esc(h.title)}</h2>${h.lead ? `<p>${esc(h.lead)}</p>` : ""}</div></div>`;

/** 日別 PV（全サイト共通）から週次・30日の数値を出す。asOf 当日は集計中のため含めない。 */
export function dailyStats(daily, asOf) {
  const windows = weeklyPvWindows(asOf);
  const rows = (daily ?? []).filter((d) => d?.date && d.date < asOf);
  const last7 = sumDailyPv(rows, windows.last7.from, windows.last7.to);
  const prior7 = sumDailyPv(rows, windows.prior7.from, windows.prior7.to);
  const wow = isNum(last7.pv) && isNum(prior7.pv) ? pctChange(last7.pv, prior7.pv) : null;
  const last30 = rows
    .filter((d) => d.date >= windows.last30.from && d.date <= windows.last30.to && isNum(d.pv))
    .sort((a, b) => a.date.localeCompare(b.date));
  const peaks = [...last30].sort((a, b) => b.pv - a.pv).slice(0, 4);
  const dips = [...last30].sort((a, b) => a.pv - b.pv).slice(0, 4);
  const sum30 = last30.reduce((a, d) => a + Number(d.pv), 0);
  return { windows, last7, prior7, wow, last30, peaks, dips, sum30, avg30: last30.length ? sum30 / last30.length : null };
}

/**
 * 共通週報 HTML。引数はサイトのアダプタが組み立てた「ビュー」。
 * @param {object} v
 * @param {{key:string,label:string}} v.site 例 { key: "tabelog", label: "食べログ" }（タイトル・トップライン・フッターに出る）
 * @param {string} v.storeName
 * @param {string} [v.storeKey]
 * @param {string} v.asOf YYYY-MM-DD（Asia/Tokyo の作成日。当日分の日別は集計中として除外）
 * @param {Array<{date:string,pv:number}>} [v.daily] 日別 PV（週次比較・30日推移に使う）
 * @param {string} [v.dailyAsOf] 日別の締め日（この日以降は未反映）。省略時は asOf
 * @param {{title:string[], points:string[], focus:string}} v.hero points/focus は **太字** のみ可
 * @param {Array<{label,value,unit,delta,deltaCls,note}>} v.kpis 4枚
 * @param {object} v.monthly { heading, periods:[prev,cur], subtitle, metrics:[{key,button,title,subtitle,values:[a,b],max,unit,change,cls,explain}], caption, table }
 * @param {object} v.weekly { source, table, tableNote }
 * @param {object} v.dailyPanel { source, tableSource }
 * @param {object} v.reviews { profileTitle, profileTable, newTitle, statText, note, idea }
 * @param {object} v.competitors { heading, areaLabel, list:[{name,rating,reviews,own}], insight, side:{title,sub,opportunity,missing,bullets:[{label,text}]}, table, changeNote, missing }
 * @param {object} v.area { heading, panels:[panel, panel] }
 * @param {Array<{title,body}>} v.actions 3件
 * @param {string[]} v.footnotes
 * @param {{left:string,right:string}} v.footer
 */
export function renderWeeklyReportHtml(v) {
  const asOf = v.asOf;
  const name = v.storeName || "店舗";
  const siteLabel = v.site?.label || "サイト";
  const css = loadWeeklyCss();
  // 日別の締め日（この日以降は集計中・未反映）。既定は作成日。管理画面が前日分を遅れて反映するサイトはアダプタが前倒しする。
  const dailyAsOf = v.dailyAsOf || asOf;
  const s = dailyStats(v.daily, dailyAsOf);
  const { windows, last7, prior7, wow, last30, peaks, dips, sum30, avg30 } = s;
  const reviewWindows = weeklyPvWindows(asOf);
  const cutoffText = dailyAsOf === asOf
    ? `${slashDate(asOf)}は集計中のため含めていません（0扱いにはしていません）`
    : `管理画面に未反映の${slashDate(dailyAsOf)}以降は含めていません（0扱いにはしていません。作成日 ${slashDate(asOf)}）`;
  const peakSet = new Set(peaks.map((d) => d.date));
  const dipSet = new Set(dips.map((d) => d.date));
  const periodLabelPrev = `${shortMd(windows.prior7.from)}–${shortMd(windows.prior7.to)}`;
  const periodLabelLast = `${shortMd(windows.last7.from)}–${shortMd(windows.last7.to)}`;
  const weeklyFillMax = Math.max(Number(last7.pv) || 0, Number(prior7.pv) || 0, 1);
  const wowDiff = isNum(last7.pv) && isNum(prior7.pv) ? last7.pv - prior7.pv : null;

  const m = v.monthly;
  const [p0, p1] = m.periods;
  const first = m.metrics[0];
  const monthlyJson = JSON.stringify(Object.fromEntries(m.metrics.map((x) => [x.key, {
    title: x.title, subtitle: x.subtitle, values: x.values, max: x.max, unit: x.unit, change: x.change, cls: x.cls, explain: x.explain,
  }])));

  const comp = v.competitors;
  const competitorsJson = JSON.stringify((comp.list ?? []).map((c) => ({ name: c.name, rating: c.rating ?? null, reviews: c.reviews ?? null, own: !!c.own })));
  const dailyJson = JSON.stringify(last30.map((d) => ({
    d: mdNum(d.date), w: weekdayJa(d.date), v: d.pv,
    t: peakSet.has(d.date) ? "peak" : dipSet.has(d.date) ? "dip" : "",
  })));
  const peakText = peaks.length ? peaks.map((d) => `${mdJa(d.date)} ${fmt(d.pv)}PV`).join("、") : NA;
  const dipText = dips.length ? dips.map((d) => `${mdJa(d.date)} ${fmt(d.pv)}PV`).join("、") : NA;
  const mid = last30[Math.floor(last30.length / 2)];
  const rv = v.reviews;
  const areaLabel = comp.areaLabel || "設定エリア";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>【${esc(siteLabel)}週報】${esc(name)} ${esc(slashDate(asOf))}</title>
  <style>${css}</style>
</head>
<body data-site="${esc(v.site?.key ?? "")}">
  <header class="hero">
    <div class="wrap">
      <div class="topline"><span>${esc(name)} · WEEKLY REPORT</span><span class="date">${esc(dotDate(asOf))} / ${esc(siteLabel)}</span></div>
      <div class="hero-grid">
        <div>
          <p class="eyebrow">今週のポイント</p>
          <h1>${v.hero.title.slice(0, 2).map((t) => `<span>${esc(t)}</span>`).join("")}</h1>
          <ol class="pts">
            ${v.hero.points.slice(0, 5).map((p) => `<li>${renderMd(p)}</li>`).join("\n            ")}
          </ol>
        </div>
        <aside class="hero-aside" aria-label="最優先の課題">
          <div class="small">FOCUS · まず取り組むこと</div>
          <p>${renderMd(v.hero.focus, "b")}</p>
        </aside>
      </div>
    </div>
  </header>

  <main class="wrap main">
    <section aria-labelledby="key-numbers">
      <div class="section-heading"><div><div class="section-number">SNAPSHOT</div><h2 id="key-numbers">まず、押さえたい4つの数字</h2></div></div>
      <div class="kpis">
        ${v.kpis.slice(0, 4).map((k) => `<article class="kpi">
          <div class="label">${esc(k.label)}</div>
          <div class="value">${esc(k.value)} <span class="unit">${esc(k.unit)}</span></div>
          <div class="delta ${esc(k.deltaCls || "neutral")}">${esc(k.delta || NA)}</div>
          <p class="note">${esc(k.note)}</p>
        </article>`).join("\n        ")}
      </div>
    </section>

    <section aria-labelledby="trend-heading" class="section-block">
      ${heading(m.heading, "trend-heading")}
      <div class="panels">
        <article class="panel">
          <div class="panel-top"><div><h3 id="monthly-title">月次比較</h3><p class="panel-sub" id="monthly-subtitle">${esc(m.subtitle)}</p></div><span class="badge">月次比較</span></div>
          <div class="segmented" role="group" aria-label="月次グラフの指標">
            ${m.metrics.map((x, i) => `<button type="button" data-metric="${esc(x.key)}" aria-pressed="${i === 0}">${esc(x.button)}</button>`).join("\n            ")}
          </div>
          <div class="chart-area" role="img" aria-labelledby="monthly-title" aria-describedby="monthly-alt">
            <div class="axis-line" style="top:20px"><span id="axis-max">${fmt(first.max)}</span></div>
            <div class="axis-line" style="top:calc(50% + 10px)"><span id="axis-half">${fmt(first.max / 2)}</span></div>
            <div class="axis-line" style="bottom:0"><span>0</span></div>
            <div class="bars" id="monthly-bars">
              ${[p0, p1].map((p, i) => `<div class="bar-col" data-period="${esc(p)}" style="--bar-h:${fillPct(first.values[i], first.max)}"><span class="bar-label">${fmt(first.values[i])}</span><div class="bar${i === 1 ? " current" : ""}" tabindex="0" title="${esc(p)}：${fmt(first.values[i])} ${esc(first.unit)}" aria-label="${esc(p)}：${fmt(first.values[i])} ${esc(first.unit)}"></div></div>`).join("\n              ")}
            </div>
          </div>
          <p class="chart-caption"><strong id="monthly-change" class="${esc(first.cls)}">${esc(first.change)}</strong><span id="monthly-explain">${esc(m.caption)}</span></p>
          <p class="minor-note" id="monthly-alt">${esc(p0)} ${fmt(first.values[0])} ${esc(first.unit)}、${esc(p1)} ${fmt(first.values[1])} ${esc(first.unit)}。</p>
          ${renderTable(m.table)}
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
          <p class="minor-note">出典：${esc(v.weekly.source)}。${esc(cutoffText)}。直近末日の値は速報値の可能性があり、後日修正される場合があります。${prior7.missingDates?.length || last7.missingDates?.length ? " ※日別PVに欠けあり。" : ""}</p>
          ${renderTable(v.weekly.table)}
          ${v.weekly.tableNote ? `<p class="minor-note">${esc(v.weekly.tableNote)}</p>` : ""}
        </article>
      </div>

      <article class="panel" style="margin-top:18px">
        <div class="panel-top"><div><h3 id="daily-title">直近30日の日別PV（${esc(slashDate(windows.last30.from))}–${esc(slashDate(windows.last30.to))}）</h3><p class="panel-sub">合計 ${fmt(last30.length ? sum30 : null)} PV／1日平均 ${avg30 != null ? avg30.toFixed(1) : NA} PV／出典：${esc(v.dailyPanel.source)}</p></div><span class="badge">30日推移</span></div>
        ${last30.length ? `<div class="daily" id="daily-bars" role="group" aria-label="日別PVの棒グラフ。各棒にフォーカスすると値を表示します。"></div>
        <div class="daily-axis"><span>${esc(mdNum(last30[0].date))}</span><span>${esc(mdNum(mid.date))}</span><span>${esc(mdNum(last30.at(-1).date))}</span></div>
        <div class="legend"><span><i style="background:var(--green-2)"></i>ピーク上位4日</span><span><i style="background:var(--orange)"></i>落ち込み下位4日</span><span><i style="background:#b6d0c4"></i>その他</span></div>
        <div id="daily-readout" aria-live="polite">棒にカーソルを合わせるか、Tabキーで選択すると値を表示します。</div>
        <div class="hl">
          <div><b>ピーク</b>${esc(peakText)}</div>
          <div class="dip"><b>落ち込み</b>${esc(dipText)}</div>
        </div>
        <details><summary>日別データ表を開く（${last30.length}日分）</summary>
          <div class="tbl-wrap"><table class="data"><caption>表3 日別アクセス数（出典：${esc(v.dailyPanel.tableSource)}／単位：PV／${esc(slashDate(dailyAsOf))}${dailyAsOf === asOf ? "は集計中" : "以降は未反映"}のため除外）</caption>
          <thead><tr><th>日付</th><th class="num">PV</th><th>区分</th></tr></thead>
          <tbody>${last30.map((d) => `<tr><td>${esc(slashDate(d.date))}（${weekdayJa(d.date)}）</td><td class="num">${fmt(d.pv)}</td><td>${peakSet.has(d.date) ? "ピーク" : dipSet.has(d.date) ? "落ち込み" : ""}</td></tr>`).join("")}</tbody>
          </table></div>
        </details>` : missingNote("日別PV")}
      </article>
    </section>

    <section aria-labelledby="review-heading" class="section-block">
      ${heading({ number: "02 / RATING & REVIEWS", title: "自店の評価と新着口コミ" }, "review-heading")}
      <div class="two-col">
        <article class="panel">
          <h3>${esc(rv.profileTitle)}</h3>
          ${renderTable(rv.profileTable)}
        </article>
        <article class="panel">
          <h3>${esc(rv.newTitle || "直近7日の新着口コミ")}</h3>
          <p class="panel-sub">確認範囲：${esc(slashDate(reviewWindows.last7.from))}–${esc(slashDate(asOf))}</p>
          <div class="review-stat"><strong>${esc(rv.statText)}</strong></div>
          <p class="review-note">${esc(rv.note)}</p>
          <p class="minor-note">${esc(rv.idea)}</p>
        </article>
      </div>
    </section>

    <section aria-labelledby="position-heading" class="section-block">
      ${heading(comp.heading, "position-heading")}
      <div class="two-col">
        <article class="panel">
          <div class="panel-top"><div><h3 id="rank-title">評価比較</h3><p class="panel-sub" id="rank-subtitle">${esc(areaLabel)} / ${esc(slashDate(asOf))}時点 / 5点満点</p></div></div>
          <div class="segmented" role="group" aria-label="競合比較の指標">
            <button type="button" data-rank="rating" aria-pressed="true">評価</button>
            <button type="button" data-rank="reviews" aria-pressed="false">口コミ数</button>
          </div>
          <div class="competitor-rows" id="competitor-rows" role="img" aria-labelledby="rank-title" aria-describedby="rank-alt"></div>
          <p class="insight-box" id="rank-insight"><strong>読み取り：</strong>${esc(comp.insight)}</p>
          <p class="minor-note" id="rank-alt">${comp.list?.length ? "" : "競合データ：未取得"}</p>
        </article>
        <article class="panel">
          <h3>${esc(comp.side.title)}</h3>
          <p class="panel-sub">${esc(comp.side.sub)}</p>
          ${comp.side.opportunity ? `<div class="opportunity">
            <div class="tag">${esc(comp.side.opportunity.tag)}</div>
            <div class="price">${esc(comp.side.opportunity.price)}</div>
            <p>${esc(comp.side.opportunity.note)}</p>
          </div>` : missingNote(comp.side.missing)}
          <ul class="minor-note">
            ${(comp.side.bullets ?? []).map((b) => `<li><b>${esc(b.label)}：</b>${esc(b.text)}</li>`).join("\n            ")}
          </ul>
        </article>
      </div>
      <article class="panel">
        ${comp.table ? `${renderTable(comp.table)}
        <p class="insight-box"><strong>最近の変化：</strong>${esc(comp.changeNote)}</p>`
        : missingNote(comp.missing || "競合詳細")}
      </article>
    </section>

    <section aria-labelledby="new-heading" class="section-block">
      ${heading(v.area.heading, "new-heading")}
      <div class="panels">
        ${v.area.panels.map(renderPanel).join("\n        ")}
      </div>
    </section>

    <section aria-labelledby="action-heading">
      <div class="section-heading"><div><div class="section-number">NEXT ACTIONS</div><h2 id="action-heading">次に取り組む3つのこと</h2><p>実行しやすい順にまとめました。</p></div></div>
      <div class="action-grid">
        ${v.actions.slice(0, 3).map((a, i) => `<article class="action"><span class="action-no">0${i + 1}</span><h3>${esc(a.title)}</h3><p>${esc(a.body)}</p></article>`).join("")}
      </div>
    </section>

    <aside class="footnote" aria-label="データの見方">
      <strong>数字の見方</strong>
      <ul>
        ${v.footnotes.map((f) => `<li>${esc(f)}</li>`).join("\n        ")}
      </ul>
    </aside>
    <footer class="footer"><span>${esc(v.footer.left)}</span><span>${esc(v.footer.right)}</span></footer>
  </main>

  <script>
    (() => {
      const monthly = ${monthlyJson};
      const periods = [${JSON.stringify(p0)}, ${JSON.stringify(p1)}];
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
      renderMonthly(${JSON.stringify(first.key)});
      renderRank('rating');
      renderDaily();
    })();
  </script>
</body>
</html>`;
}

export { weeklyPvWindows, sumDailyPv, pctChange, shiftDate, within30Days };

/**
 * 複数サイトの週報を GitHub Pages で開くためのハブ HTML（カードの「週報を開く」先）。
 * 各サイトの本体は同じディレクトリの `<site.key>.html`（共通テンプレートのまま）。
 * サイト別 HTML は ID が衝突するため 1 枚に連結せず、ハブからリンクする。
 */
export function renderWeeklyHubHtml(views, { storeName, asOf } = {}) {
  const list = Array.isArray(views) ? views.filter(Boolean) : [];
  if (!list.length) throw new Error("views が空です");
  const name = storeName || list[0].storeName || "店舗";
  const day = asOf || list[0].asOf;
  const labels = list.map((v) => v.site?.label || v.site?.key || "サイト");
  const cards = list.map((v) => {
    const key = esc(v.site?.key || "site");
    const label = esc(v.site?.label || key);
    const href = `${key}.html`;
    return `<a class="hub-card" href="${href}"><span class="hub-eyebrow">${label}週報</span><strong>${esc(name)}</strong><span class="hub-meta">${esc(slashDate(day))} 作成 · 共通テンプレート</span><span class="hub-cta">開く →</span></a>`;
  }).join("\n        ");
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="robots" content="noindex">
  <title>${esc(name)} 週報（${esc(labels.join("・"))}） ${esc(slashDate(day))}</title>
  <style>
    :root { --ink:#20322e; --muted:#65736d; --paper:#f7f6f1; --card:#fffefa; --line:#e8e7de; --green:#174f46; --mint:#cde7dc; --shadow:0 15px 40px rgba(24,50,41,.07); }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif; line-height: 1.65; }
    a { color: inherit; text-decoration: none; }
    .wrap { width: min(720px, calc(100% - 40px)); margin: auto; padding: 48px 0 64px; }
    .hero { background: #123c35; color: #fffdf5; padding: 36px 0 40px; }
    .hero .wrap { padding-top: 0; padding-bottom: 0; }
    .topline { display: flex; justify-content: space-between; gap: 16px; color: #d7e9dc; font-size: 12px; letter-spacing: .13em; font-weight: 700; }
    .eyebrow { color: #a4d3ba; font-size: 12px; letter-spacing: .18em; font-weight: 800; margin: 28px 0 10px; }
    h1 { font-size: clamp(28px, 6vw, 44px); font-weight: 800; letter-spacing: -.04em; line-height: 1.2; margin: 0; }
    .sub { margin: 14px 0 0; color: #c6d9cd; font-size: 14px; }
    .hub-grid { display: grid; gap: 16px; margin-top: 28px; }
    .hub-card { display: grid; gap: 6px; background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px 22px 18px; box-shadow: var(--shadow); transition: transform .15s ease, border-color .15s ease; }
    .hub-card:hover, .hub-card:focus-visible { transform: translateY(-2px); border-color: var(--mint); outline: none; }
    .hub-eyebrow { color: var(--green); font-size: 12px; letter-spacing: .14em; font-weight: 800; }
    .hub-card strong { font-size: 20px; letter-spacing: -.02em; }
    .hub-meta { color: var(--muted); font-size: 13px; }
    .hub-cta { margin-top: 8px; color: var(--green); font-weight: 700; font-size: 14px; }
    .note { margin-top: 28px; color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <div class="topline"><span>${esc(name)} · WEEKLY REPORT</span><span>${esc(slashDate(day))}</span></div>
      <p class="eyebrow">週報を開く</p>
      <h1>${esc(name)} 週報</h1>
      <p class="sub">${esc(labels.join("・"))} · 承認済みの共通テンプレート</p>
    </div>
  </header>
  <main class="wrap">
    <div class="hub-grid">
        ${cards}
    </div>
    <p class="note">各サイトの週報は同じ見た目の共通テンプレートです。数値は各サイトの管理画面・公開ページから取得した値です（取れなかった項目は「未取得」）。お客様の氏名・連絡先は載せていません。</p>
  </main>
</body>
</html>`;
}
