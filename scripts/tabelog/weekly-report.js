// 食べログ週報 HTML 生成（オフライン。外部リソースなし）。エージェント／ローカル用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pctChange, shiftDate, sumDailyPv, weeklyPvWindows, within30Days } from "./weekly-windows.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const loadCss = () => fs.readFileSync(path.join(__dir, "weekly-report.css.txt"), "utf8");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => (n == null || !Number.isFinite(n) ? "—" : Number(n).toLocaleString("ja-JP"));
const fmtPct = (n) => (n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`.replace("−-", "−"));
const clsDelta = (n) => (n == null ? "neutral" : n > 0 ? "positive" : n < 0 ? "negative" : "neutral");
const yen = (s) => (s ? esc(s) : "掲載なし");

function monthLabel(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return `${Number(y)}年${Number(m)}月`;
}
function shortMonth(ym) {
  return ym ? `${Number(ym.slice(5))}月` : "";
}
function weekdayJa(date) {
  return ["日", "月", "火", "水", "木", "金", "土"][new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/**
 * @param {object} input
 * @param {string} input.storeName
 * @param {string} input.storeKey
 * @param {string} input.asOf YYYY-MM-DD
 * @param {object} [input.monthly] { prev: {month,pv,reservations,calls,pvPc,pvSp,pvApp}, cur: {...} }
 * @param {Array<{date,pv}>} [input.daily]
 * @param {object} [input.publicProfile] { rating, reviewCount, saveCount, budgetNight, budgetDay, station }
 * @param {object} [input.notices] { new, changed, cancelled }
 * @param {number} [input.newReviews7d]
 * @param {object} [input.accessRanking] { area, self: {rank,pv}, momPct }
 * @param {Array} [input.competitors] top+self profiles
 * @param {Array} [input.genreRanks] { label, rank, note }
 * @param {Array} [input.newOpens]
 * @param {string[]} [input.nextActions]
 * @param {string} [input.heroLead]
 * @param {string} [input.focusText]
 */
export function buildWeeklyReportHtml(input) {
  const asOf = input.asOf;
  const name = input.storeName || "店舗";
  const css = loadCss();
  const windows = weeklyPvWindows(asOf);
  const daily = input.daily ?? [];
  const last7 = sumDailyPv(daily, windows.last7.from, windows.last7.to);
  const prior7 = sumDailyPv(daily, windows.prior7.from, windows.prior7.to);
  const wow = pctChange(last7.pv, prior7.pv);
  const last30 = daily.filter((d) => d.date >= windows.last30.from && d.date <= windows.last30.to && d.pv != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const peaks = [...last30].sort((a, b) => b.pv - a.pv).slice(0, 4);
  const dips = [...last30].sort((a, b) => a.pv - b.pv).slice(0, 4);
  const peakSet = new Set(peaks.map((d) => d.date));
  const dipSet = new Set(dips.map((d) => d.date));

  const cur = input.monthly?.cur ?? {};
  const prev = input.monthly?.prev ?? {};
  const pvMom = pctChange(cur.pv, prev.pv);
  const resMom = pctChange(cur.reservations, prev.reservations);
  const callMom = pctChange(cur.calls, prev.calls);
  const profile = input.publicProfile ?? {};
  const notices = input.notices ?? null;
  const competitors = input.competitors ?? [];
  const genreRanks = input.genreRanks ?? [];
  const newOpens = input.newOpens ?? [];
  const access = input.accessRanking ?? null;
  const newReviews7d = input.newReviews7d ?? null;

  const missing = (label) => `<p class="panel-sub">（${esc(label)}：データ未取得）</p>`;

  const heroLead = input.heroLead ?? [
    cur.pv != null ? `${shortMonth(cur.month)}のPVは${fmt(cur.pv)}（前月比${fmtPct(pvMom)}）` : null,
    cur.reservations != null ? `ネット予約${fmt(cur.reservations)}組` : null,
    cur.calls != null ? `通話成立${fmt(cur.calls)}件` : null,
    newReviews7d != null ? `直近7日の新着口コミ${fmt(newReviews7d)}件` : null,
    profile.rating != null ? `評価${Number(profile.rating).toFixed(2)}・口コミ${fmt(profile.reviewCount)}件` : null,
  ].filter(Boolean).join("。") + "。";

  const focusText = input.focusText
    ?? (cur.calls != null && prev.calls != null
      ? `通話成立は${fmt(prev.calls)}→${fmt(cur.calls)}。※通話成立≠予約確定。`
      : "データがそろい次第、フォーカス指標を表示します。");

  const nextActions = (input.nextActions?.length ? input.nextActions : [
    { title: "口コミのきっかけを作る", body: "来店後の案内や卓上で、投稿しやすい導線を確認する。" },
    { title: "予約導線を見直す", body: "閲覧からネット予約・電話への導線（コース・空席・写真）を点検する。" },
    { title: "ランチの魅力を具体的に見せる", body: "昼予算が相対的に有利なら、写真とメニューで明示する。" },
  ]);

  const dailyJson = JSON.stringify(last30.map((d) => ({
    d: `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}`,
    w: weekdayJa(d.date),
    v: d.pv,
    t: peakSet.has(d.date) ? "peak" : dipSet.has(d.date) ? "dip" : "",
  })));
  const competitorsJson = JSON.stringify(competitors.map((c) => ({
    name: c.own ? `${c.name}（自店）` : c.name,
    rating: c.rating, reviews: c.reviews, own: !!c.own,
  })));
  const monthlyJson = JSON.stringify({
    pv: {
      title: cur.pv != null ? `ページ閲覧数は前月比${fmtPct(pvMom)}` : "ページ閲覧数（データ未取得）",
      subtitle: `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値 / PV`,
      values: [prev.pv ?? 0, cur.pv ?? 0],
      max: Math.max(prev.pv ?? 0, cur.pv ?? 0, 1) * 1.2,
      unit: "PV", change: fmtPct(pvMom), cls: clsDelta(pvMom),
      explain: cur.pv != null && prev.pv != null ? `閲覧数の差分は ${fmt(cur.pv - prev.pv)} PV。` : "月次PVが未取得です。",
    },
    booking: {
      title: cur.reservations != null ? `ネット予約は${fmt(prev.reservations)}組から${fmt(cur.reservations)}組へ` : "ネット予約（データ未取得）",
      subtitle: `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値 / 組`,
      values: [prev.reservations ?? 0, cur.reservations ?? 0],
      max: Math.max(prev.reservations ?? 0, cur.reservations ?? 0, 1) * 1.2,
      unit: "組", change: fmtPct(resMom), cls: clsDelta(resMom),
      explain: "インターネット予約組数（来店指標）。",
    },
    calls: {
      title: cur.calls != null ? `電話の通話成立は${fmt(prev.calls)}件から${fmt(cur.calls)}件へ` : "通話成立（データ未取得）",
      subtitle: `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値 / 件`,
      values: [prev.calls ?? 0, cur.calls ?? 0],
      max: Math.max(prev.calls ?? 0, cur.calls ?? 0, 1) * 1.2,
      unit: "件", change: fmtPct(callMom), cls: clsDelta(callMom),
      explain: "食べログ予約専用番号の通話成立数です。予約確定数とは異なります。",
    },
  });

  const areaNote = access?.area ? esc(access.area) : "設定エリア";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>【食べログ週報】${esc(name)} ${esc(asOf.replace(/-/g, "/"))}</title>
  <style>${css}</style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <div class="topline"><span>TABELOG WEEKLY</span><span class="date">${esc(asOf.replace(/-/g, "/"))}</span></div>
      <div class="hero-grid">
        <div>
          <p class="eyebrow">今週のポイント</p>
          <h1><span>${esc(name)}</span></h1>
          <p class="hero-lead">${esc(heroLead)}</p>
        </div>
        <aside class="hero-aside">
          <div class="small">FOCUS</div>
          <p>${esc(focusText)}</p>
        </aside>
      </div>
    </div>
  </header>
  <main class="main wrap">
    <div class="section-heading"><div><div class="section-number">SNAPSHOT</div><h2>まず、押さえたい4つの数字</h2></div></div>
    <div class="kpis">
      <article class="kpi"><div class="label">${esc(shortMonth(cur.month) || "月次")}のページ閲覧数</div><div class="value">${fmt(cur.pv)}<span class="unit">PV</span></div><div class="delta ${clsDelta(pvMom)}">${fmtPct(pvMom)}</div><p class="note">前月比</p></article>
      <article class="kpi"><div class="label">${esc(shortMonth(cur.month) || "月次")}のネット予約</div><div class="value">${fmt(cur.reservations)}<span class="unit">組</span></div><div class="delta ${clsDelta(resMom)}">${fmtPct(resMom)}</div><p class="note">前月比</p></article>
      <article class="kpi"><div class="label">${esc(shortMonth(cur.month) || "月次")}の電話通話成立</div><div class="value">${fmt(cur.calls)}<span class="unit">件</span></div><div class="delta ${clsDelta(callMom)}">${fmtPct(callMom)}</div><p class="note">※予約確定ではない</p></article>
      <article class="kpi"><div class="label">直近7日の新着口コミ</div><div class="value">${fmt(newReviews7d)}<span class="unit">件</span></div><div class="delta neutral">累計 ${fmt(profile.reviewCount)}</div><p class="note">管理画面の投稿日ベース</p></article>
    </div>

    <div class="section-heading"><div><div class="section-number">01 / STORE ADMIN</div><h2>店舗管理データ：閲覧と予約の動き</h2><p>出典：来店指標・アクセス数レポート・トップ通知</p></div></div>
    <div class="panels">
      <article class="panel">
        <div class="panel-top"><div><h3 id="monthly-title">月次推移</h3><p class="panel-sub" id="monthly-subtitle"></p></div><span class="badge">表1</span></div>
        <div class="segmented" role="group">
          <button type="button" data-metric="pv" aria-pressed="true">PV</button>
          <button type="button" data-metric="booking" aria-pressed="false">ネット予約</button>
          <button type="button" data-metric="calls" aria-pressed="false">通話成立</button>
        </div>
        <div class="bars-wrap" style="display:flex;gap:28px;align-items:end;height:180px;margin-top:18px" id="monthly-bars">
          <div class="bar-col" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:end;height:100%"><span class="bar-label"></span><div class="bar" style="width:48px;height:var(--bar-h,10%);background:var(--green);border-radius:10px 10px 0 0"></div><span>${esc(shortMonth(prev.month))}</span></div>
          <div class="bar-col" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:end;height:100%"><span class="bar-label"></span><div class="bar" style="width:48px;height:var(--bar-h,10%);background:var(--green-2);border-radius:10px 10px 0 0"></div><span>${esc(shortMonth(cur.month))}</span></div>
        </div>
        <p><span id="monthly-change"></span> · <span id="monthly-explain"></span></p>
        <p class="panel-sub" id="monthly-alt"></p>
        <table>
          <caption>表1 月次比較</caption>
          <thead><tr><th>指標</th><th>${esc(monthLabel(prev.month))}</th><th>${esc(monthLabel(cur.month))}</th><th>前月比</th></tr></thead>
          <tbody>
            <tr><td>アクセス数（PV）</td><td>${fmt(prev.pv)}</td><td>${fmt(cur.pv)}</td><td class="${clsDelta(pvMom)}">${fmtPct(pvMom)}</td></tr>
            <tr><td>通話成立数（件）</td><td>${fmt(prev.calls)}</td><td>${fmt(cur.calls)}</td><td class="${clsDelta(callMom)}">${fmtPct(callMom)}</td></tr>
            <tr><td>インターネット予約組数</td><td>${fmt(prev.reservations)}</td><td>${fmt(cur.reservations)}</td><td class="${clsDelta(resMom)}">${fmtPct(resMom)}</td></tr>
            <tr><td>PV内訳 PC／SP／アプリ</td><td>${fmt(prev.pvPc)}／${fmt(prev.pvSp)}／${fmt(prev.pvApp)}</td><td>${fmt(cur.pvPc)}／${fmt(cur.pvSp)}／${fmt(cur.pvApp)}</td><td>—</td></tr>
          </tbody>
        </table>
      </article>
      <article class="panel">
        <div class="panel-top"><div><h3>直近7日の閲覧数</h3><p class="panel-sub">${esc(windows.prior7.from)}–${esc(windows.prior7.to)} vs ${esc(windows.last7.from)}–${esc(windows.last7.to)}</p></div><span class="badge">週次</span></div>
        <p>前の7日間: <strong>${fmt(prior7.pv)}</strong> PV　／　直近7日間: <strong>${fmt(last7.pv)}</strong> PV（${fmtPct(wow)}）</p>
        ${prior7.missingDates?.length || last7.missingDates?.length ? missing("日別PVに欠けあり") : ""}
        <div class="panel-top" style="margin-top:22px"><div><h3>予約通知</h3><p class="panel-sub">確認時点の件数（期間合計ではない）</p></div><span class="badge">表2</span></div>
        ${notices ? `<table><thead><tr><th>区分</th><th>通知件数</th></tr></thead><tbody>
          <tr><td>新規予約</td><td>${fmt(notices.new)}</td></tr>
          <tr><td>予約内容の変更</td><td>${fmt(notices.changed)}</td></tr>
          <tr><td>キャンセル</td><td>${fmt(notices.cancelled)}</td></tr>
        </tbody></table><p class="panel-sub">※確認時点で表示されていた新着通知の件数です。週・月の予約総数やキャンセル総数ではありません。</p>`
        : missing("予約通知")}
      </article>
    </div>

    <article class="panel" style="margin-bottom:34px">
      <div class="panel-top"><div><h3>直近30日の日別PV</h3><p class="panel-sub">${esc(windows.last30.from)}–${esc(windows.last30.to)}（${esc(asOf)}は集計中のため除外）</p></div><span class="badge">表3</span></div>
      <div id="daily-bars" class="daily-bars" style="display:flex;gap:3px;align-items:end;height:140px;margin:16px 0" role="img" aria-label="日別PVの棒グラフ。各棒にフォーカスすると値を表示します。"></div>
      <p id="daily-readout" class="panel-sub">棒にフォーカスすると値を表示します。</p>
      <p class="panel-sub">ピーク上位: ${peaks.map((d) => `${esc(d.date)} ${fmt(d.pv)}`).join(" · ") || "—"} ／ 落ち込み: ${dips.map((d) => `${esc(d.date)} ${fmt(d.pv)}`).join(" · ") || "—"}</p>
    </article>

    <div class="section-heading"><div><div class="section-number">02 / RATING &amp; REVIEWS</div><h2>自店の評価と新着口コミ</h2></div></div>
    <div class="panels">
      <article class="panel">
        <div class="panel-top"><div><h3>評価・口コミ・保存数</h3><p class="panel-sub">公開店舗ページ</p></div><span class="badge">表4</span></div>
        <table><thead><tr><th>指標</th><th>値</th><th>単位</th></tr></thead><tbody>
          <tr><td>評価</td><td>${profile.rating != null ? Number(profile.rating).toFixed(2) : "—"}</td><td>点（5点満点）</td></tr>
          <tr><td>口コミ数</td><td>${fmt(profile.reviewCount)}</td><td>件</td></tr>
          <tr><td>保存数</td><td>${fmt(profile.saveCount)}</td><td>人</td></tr>
          <tr><td>予算（夜／昼）</td><td>${yen(profile.budgetNight)}／${yen(profile.budgetDay)}</td><td>円</td></tr>
        </tbody></table>
      </article>
      <article class="panel">
        <div class="panel-top"><div><h3>直近7日の新着口コミ</h3><p class="panel-sub">管理画面の投稿日（公開ページに投稿日は無い）</p></div></div>
        <p>${newReviews7d == null ? "データ未取得" : newReviews7d === 0 ? "直近7日の新着口コミは0件。" : `直近7日の新着口コミは${fmt(newReviews7d)}件。`}</p>
      </article>
    </div>

    <div class="section-heading"><div><div class="section-number">03 / COMPETITORS</div><h2>競合比較（評価上位5店）</h2><p>${areaNote}</p></div></div>
    <div class="panels">
      <article class="panel">
        <div class="panel-top"><div><h3 id="rank-title">評価比較</h3><p class="panel-sub" id="rank-subtitle"></p></div><span class="badge">切替</span></div>
        <div class="segmented" role="group">
          <button type="button" data-rank="rating" aria-pressed="true">評価</button>
          <button type="button" data-rank="reviews" aria-pressed="false">口コミ</button>
        </div>
        <div id="competitor-rows" style="margin-top:16px"></div>
        <p class="panel-sub" id="rank-insight"></p>
        <p class="panel-sub" id="rank-alt"></p>
        ${competitors.length ? "" : missing("競合スナップショット")}
      </article>
      <article class="panel">
        <div class="panel-top"><div><h3>競合詳細</h3><p class="panel-sub">公開ページ</p></div><span class="badge">表5</span></div>
        ${competitors.length ? `<table><thead><tr><th>#</th><th>店名</th><th>評価</th><th>口コミ</th><th>夜予算</th><th>昼予算</th><th>最寄駅</th><th>保存</th></tr></thead><tbody>
          ${competitors.map((c, i) => `<tr${c.own ? ' class="own"' : ""}><td>${c.own ? "—" : i + 1}</td><td>${esc(c.name)}${c.own ? "（自店）" : ""}</td><td>${c.rating != null ? Number(c.rating).toFixed(2) : "—"}</td><td>${fmt(c.reviews)}</td><td>${yen(c.budgetNight)}</td><td>${yen(c.budgetDay)}</td><td>${esc(c.station ?? "—")}</td><td>${fmt(c.saveCount)}</td></tr>`).join("")}
        </tbody></table>` : missing("競合詳細")}
      </article>
    </div>

    <div class="section-heading"><div><div class="section-number">04 / AREA</div><h2>エリアの新規オープンとランキング</h2></div></div>
    <div class="panels">
      <article class="panel">
        <div class="panel-top"><div><h3>直近30日の新規オープン・新規掲載</h3></div><span class="badge">表6</span></div>
        ${newOpens.length ? `<table><thead><tr><th>エリア</th><th>店名（ジャンル）</th><th>オープン日</th><th>30日以内</th></tr></thead><tbody>
          ${newOpens.map((e) => `<tr><td>${esc(e.areaLabel ?? "")}</td><td>${esc(e.name)}${e.genreLabel ? `（${esc(e.genreLabel)}）` : ""}</td><td>${esc(e.openedOn ?? "—")}</td><td>${e.within30d ? "対象" : "対象外"}</td></tr>`).join("")}
        </tbody></table>` : missing("ニューオープン一覧")}
      </article>
      <article class="panel">
        <div class="panel-top"><div><h3>自店のエリア内順位</h3></div><span class="badge">表7</span></div>
        <table><thead><tr><th>ランキング</th><th>順位</th><th>備考</th></tr></thead><tbody>
          <tr><td>アクセス数ランキング</td><td>${access?.self?.rank != null ? fmt(access.self.rank) : "—"}</td><td>${access?.self?.pv != null ? `${fmt(access.self.pv)}PV` : ""}${access?.momPct != null ? `、前月比${fmtPct(access.momPct)}` : ""}</td></tr>
          ${genreRanks.length ? genreRanks.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.rank != null ? fmt(g.rank) : "—"}</td><td>${esc(g.note ?? "広告枠を除く掲載順")}</td></tr>`).join("")
            : `<tr><td colspan="3">ジャンル公開順位：データ未取得</td></tr>`}
        </tbody></table>
      </article>
    </div>

    <div class="section-heading"><div><div class="section-number">NEXT ACTIONS</div><h2>次に取り組む3つのこと</h2></div></div>
    <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
      ${nextActions.slice(0, 3).map((a, i) => `<article class="kpi"><div class="label">0${i + 1}</div><div class="value" style="font-size:20px">${esc(a.title)}</div><p class="note">${esc(a.body)}</p></article>`).join("")}
    </div>

    <footer class="footnotes" style="margin-top:40px;color:var(--muted);font-size:12px">
      <p>※月次は確定月のみ比較。通話成立≠予約確定。予約通知件数≠期間合計。公開ページに口コミ投稿日はありません。本ファイルはオフライン閲覧用です。</p>
      <p>店舗ID ${esc(input.storeKey || "")} ／ 生成 ${esc(asOf)}</p>
    </footer>
  </main>
  <script>
    (() => {
      const monthly = ${monthlyJson};
      const periods = [${JSON.stringify(shortMonth(prev.month))}, ${JSON.stringify(shortMonth(cur.month))}];
      const competitors = ${competitorsJson};
      const daily = ${dailyJson};
      const format = value => Number(value).toLocaleString('ja-JP');
      const byId = id => document.getElementById(id);
      function renderMonthly(key) {
        const d = monthly[key]; if (!d || !byId('monthly-title')) return;
        byId('monthly-title').textContent = d.title;
        byId('monthly-subtitle').textContent = d.subtitle;
        byId('monthly-change').textContent = d.change;
        byId('monthly-change').className = d.cls;
        byId('monthly-explain').textContent = d.explain;
        const cols = byId('monthly-bars').children;
        d.values.forEach((value, index) => {
          cols[index].style.setProperty('--bar-h', Math.max(4, value / d.max * 100) + '%');
          cols[index].querySelector('.bar-label').textContent = format(value);
          const bar = cols[index].querySelector('.bar');
          bar.title = periods[index] + '：' + format(value) + ' ' + d.unit;
        });
        byId('monthly-alt').textContent = periods[0] + ' ' + format(d.values[0]) + ' ' + d.unit + '、' + periods[1] + ' ' + format(d.values[1]) + ' ' + d.unit;
        document.querySelectorAll('[data-metric]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.metric === key)));
      }
      function renderRank(key) {
        const isRating = key === 'rating';
        if (!byId('rank-title')) return;
        byId('rank-title').textContent = isRating ? '評価比較' : '口コミ件数比較';
        byId('rank-subtitle').textContent = ${JSON.stringify(areaNote)} + ' / 時点の公開データ';
        const list = byId('competitor-rows'); list.replaceChildren();
        if (!competitors.length) { byId('rank-insight').textContent = '競合データ未取得'; return; }
        const sorted = [...competitors].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
        const max = isRating ? 5 : Math.max(...sorted.map(i => i.reviews || 0), 1);
        sorted.forEach(item => {
          const row = document.createElement('div');
          row.className = 'competitor-row' + (item.own ? ' own' : '');
          row.style.cssText = 'display:grid;grid-template-columns:140px 1fr 64px;gap:10px;align-items:center;margin:6px 0';
          const name = document.createElement('span'); name.textContent = item.name;
          const track = document.createElement('div'); track.style.cssText = 'background:#eef2ec;border-radius:99px;height:10px;overflow:hidden';
          const bar = document.createElement('span'); bar.style.cssText = 'display:block;height:100%;background:var(--green-2);width:' + ((item[key] || 0) / max * 100) + '%';
          track.append(bar);
          const value = document.createElement('span'); value.textContent = isRating ? (item.rating != null ? item.rating.toFixed(2) : '—') : format(item.reviews ?? 0);
          row.append(name, track, value); list.append(row);
        });
        byId('rank-insight').textContent = '読み取り：公開ランキング上位との比較（広告枠除く）。';
        document.querySelectorAll('[data-rank]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rank === key)));
      }
      function renderDaily() {
        const box = byId('daily-bars'); const out = byId('daily-readout'); if (!box) return;
        const max = Math.max(...daily.map(d => d.v), 1);
        daily.forEach(d => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'dbar ' + (d.t || '');
          b.style.cssText = 'flex:1;height:var(--h);background:' + (d.t === 'peak' ? 'var(--orange)' : d.t === 'dip' ? 'var(--mint)' : 'var(--green)') + ';border:0;border-radius:4px 4px 0 0;padding:0;align-self:end';
          b.style.setProperty('--h', (d.v / max * 100) + '%');
          const text = d.d + '（' + d.w + '）：' + format(d.v) + ' PV';
          b.title = text; b.addEventListener('mouseenter', () => { out.textContent = text; });
          b.addEventListener('focus', () => { out.textContent = text; });
          box.append(b);
        });
      }
      document.querySelectorAll('[data-metric]').forEach(b => b.addEventListener('click', () => renderMonthly(b.dataset.metric)));
      document.querySelectorAll('[data-rank]').forEach(b => b.addEventListener('click', () => renderRank(b.dataset.rank)));
      renderMonthly('pv'); renderRank('rating'); renderDaily();
    })();
  </script>
</body>
</html>`;
}

/** DB/ツール結果から週報入力を組み立てる（足りない節は空→「データ未取得」） */
export function assembleWeeklyReportInput({
  storeKey, storeName, asOf, monthlyRows = [], dailyRows = [], reviews = [],
  publicProfile = null, notices = null, accessRanking = null,
  competitors = [], genreRanks = [], newOpens = [], nextActions,
}) {
  const months = [...monthlyRows].filter((m) => m.month).sort((a, b) => a.month.localeCompare(b.month));
  const curMonth = asOf.slice(0, 7);
  // 直近の確定月（当月より前）と、その前月
  const complete = months.filter((m) => m.month < curMonth);
  const cur = complete.at(-1) ?? months.at(-1) ?? null;
  const prev = cur ? complete.filter((m) => m.month < cur.month).at(-1) ?? null : null;
  const windows = weeklyPvWindows(asOf);
  const newReviews7d = reviews.filter((r) => {
    const d = r.postedAt ?? r.review_date ?? r.date;
    return d && d >= windows.last7.from && d <= windows.last7.to;
  }).length;
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
  };
}

export { weeklyPvWindows, sumDailyPv, pctChange, shiftDate, within30Days };
