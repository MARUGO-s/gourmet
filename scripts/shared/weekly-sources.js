// 週報の入力を「最新の実取得データ」から組み立てる（Grok Bot の配信作業用。ネットワークには接続しない）。
// 2026-10-05 の事故（手書きの薄い stub 入力で公開 → 大半が「未取得」・日別が合成値）を繰り返さないための唯一の入口。
//   食べログ: 取得の取り込み JSON（payload*.json: 月別・日別・端末内訳・口コミ・レポート〔公開ページ・競合・ジャンル順位・ニューオープン・予約通知〕）
//            ＋ 管理トップの保存 HTML（owner-home*.html: 新着ご予約の件数のみ）＋ アクセス数ランキングの保存 HTML（pages/tabelog_access_ranking-YYYY-MM.html）
//   一休:    取り込み JSON（当日の取得＋過去月のバックフィル＋公開ページ）を capturedAt の古い順に重ねる（assembleIkyuWeeklyInput）
// 作成日より後の取得: stub の確認を通ったうえで、作成日より前の日付の行（日別 PV・確定月の月別）だけ使う。取得時点の値（公開ページ・予約通知・ランキング・口コミ）は使わない。
// stub の見分け: schemaVersion/agent/runId が取り込み JSON の形でない（例 runId "t"）・日別 PV が周期的な合成値・配信の出力フォルダ（weekly-card-*.json がある）。
// 出力には assembled（作った道具・元ファイル・取得日時・足りない項目）を付け、scripts/weekly-deliver.mjs --send はこれが無い入力を送らない。
import fs from "node:fs";
import path from "node:path";
import { parseHtml } from "../ikyu/html-lite.js";
import { storePublicConfig } from "../tabelog/store-config.js";
import { assembleWeeklyReportInput } from "../tabelog/weekly-report.js";
import { assembleIkyuWeeklyInput } from "../ikyu/weekly-report.js";
import { shiftDate, weeklyPvWindows } from "./weekly-windows.js";

export const ASSEMBLER = "weekly-assemble";
export const ASSEMBLER_VERSION = 1;
/** 実取得の仕組みがまだ無い項目（「未取得」が正しい。作らない） */
export const KNOWN_GAPS = {
  tabelog: [],
  ikyu: [
    "一休の競合比較（エリア上位店・プラン価格）: 一休の公開一覧の取得は未対応",
    "一休のエリア内順位: 未対応",
    "一休の直近30日の新規オープン: 未対応",
  ],
};
const DEFAULTS = { maxAgeDays: 8, noticeMaxAgeDays: 2, ikyuPublicMaxAgeDays: 14 };

const isNum = (v) => v != null && v !== "" && Number.isFinite(Number(v));
const JST = 9 * 3_600_000;
export const japanDate = (value) => {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + JST).toISOString().slice(0, 10) : null;
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const prevMonth = (ym) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** 日別 PV が周期的・等差の合成値か（stub の 100,110,…,160 の繰り返し、20〜24 の繰り返しなど） */
export function looksSynthetic(values) {
  const v = values.filter(isNum).map(Number);
  if (v.length < 14) return false;
  for (let p = 1; p <= 7; p++) {
    if (v.length - p < 7) break;
    if (v.every((x, i) => i + p >= v.length || x === v[i + p])) return true;
  }
  const d = v.slice(1).map((x, i) => x - v[i]);
  let run = 1;
  for (let i = 1; i < d.length; i++) { run = d[i] === d[i - 1] && Math.abs(d[i]) >= 5 ? run + 1 : 1; if (run >= 5) return true; }
  return false;
}

/** 取り込み JSON として受け付けない理由（null = 受け付ける） */
export function payloadProblem(p) {
  if (!p || typeof p !== "object") return "JSON ではありません";
  if (p.schemaVersion !== 1) return "schemaVersion 1 の取り込み JSON ではありません";
  if (!["tabelog", "ikyu"].includes(p.source)) return "source が tabelog / ikyu ではありません";
  if (typeof p.agent !== "string" || !p.agent) return "agent がありません（手書きの stub の可能性）";
  if (typeof p.runId !== "string" || !new RegExp(`^${p.source}-`).test(p.runId) || p.runId.length < 12) return `runId が取得の形ではありません（${String(p.runId).slice(0, 20)}）`;
  if (!japanDate(p.capturedAt)) return "capturedAt がありません";
  for (const s of p.stores ?? []) {
    const daily = p.source === "tabelog" ? (Array.isArray(s.daily) ? s.daily : []) : (s.pageviews?.months ?? []).flatMap((m) => m.days ?? []);
    const pv = [...daily].filter((d) => d?.date).sort((a, b) => a.date.localeCompare(b.date)).map((d) => d.pv);
    if (looksSynthetic(pv)) return "日別 PV が周期的な合成値です（stub）";
  }
  return null;
}

// ---------- 保存 HTML の読み取り（html-lite。ブラウザ不要） ----------
const hasClass = (n, c) => String(n.attrs?.class ?? "").split(/\s+/).includes(c);

/** 食べログ管理トップ「新着ご予約情報」の件数（scripts/tabelog/owner-home.js と同じラベル）。氏名などは読まない */
export function parseOwnerHomeNotices(html) {
  const root = parseHtml(html);
  const norm = (t) => String(t ?? "").replace(/[\s,，]/g, "");
  const LABELS = {
    new: ["新規ご予約", "新規予約", "新規のご予約"],
    changed: ["ご予約内容変更", "ご予約内容の変更", "予約内容変更", "予約内容の変更"],
    cancelled: ["ご予約キャンセル", "予約キャンセル", "ご予約の取消", "予約取消"],
  };
  const out = { new: null, changed: null, cancelled: null };
  for (const dl of root.all((n) => hasClass(n, "owner-side__today-news"))) {
    const kids = dl.children.filter((c) => typeof c !== "string");
    kids.forEach((dt, i) => {
      if (dt.tag !== "dt") return;
      const kind = Object.keys(LABELS).find((k) => LABELS[k].includes(norm(dt.inline)));
      const dd = kids[i + 1];
      const m = dd?.tag === "dd" ? norm(dd.inline).match(/^(\d+)件?$/) ?? norm(dd.inline).match(/(\d+)件/) : null;
      if (kind && out[kind] == null && m) out[kind] = Number(m[1]);
    });
  }
  const found = Object.values(out).some((v) => v != null);
  return found ? { new: out.new ?? 0, changed: out.changed ?? 0, cancelled: out.cancelled ?? 0 } : null;
}

/** アクセス数ランキングの保存 HTML → { area, entries, self }（scripts/tabelog/reports.js readRanking と同じ列） */
export function parseAccessRanking(html, shopName) {
  const root = parseHtml(html);
  const digits = (s) => (/\d/.test(s) ? Number(s.replace(/[^\d]/g, "")) : null);
  const entries = root.byTag("tr").map((tr) => {
    const cell = (c) => tr.find((n) => hasClass(n, c));
    if (!cell("rank") || !cell("rname")) return null;
    const compare = (cell("compare")?.inline ?? "").match(/[-+]?\d+(?:\.\d+)?/);
    return { rank: digits(cell("rank").inline), name: cell("rname").inline, pv: digits(cell("access")?.inline ?? ""), momPct: compare ? Number(compare[0]) : null };
  }).filter((e) => e && e.rank != null && e.name);
  const title = root.find((n) => n.tag === "title")?.inline ?? "";
  const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const self = shopName ? entries.find((e) => norm(e.name) === norm(shopName)) ?? null : null;
  return { area: title.match(/^(.+?)エリアのアクセス数ランキング/)?.[1] ?? null, entries, self };
}

// ---------- 探す ----------
/**
 * runsDir 直下の取得フォルダから、取り込み JSON・管理トップ HTML・アクセス数ランキング HTML を探す。
 * 配信の出力フォルダ（weekly-card-*.json がある）は stub の入力を含むことがあるため読まない。
 */
export function discoverRunFiles(runsDir) {
  const out = { payloads: [], ownerHomes: [], rankings: [], skipped: [] };
  if (!runsDir || !fs.existsSync(runsDir)) return out;
  for (const ent of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".") || ["node_modules", "gourmet"].includes(ent.name) || ent.name.startsWith("wt-")) continue;
    const dir = path.join(runsDir, ent.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    if (names.some((n) => /^weekly-card-.*\.json$/.test(n))) { out.skipped.push({ dir, reason: "配信の出力フォルダ" }); continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      if (/^payload.*\.json$/.test(n)) out.payloads.push(file);
      else if (/^owner-home.*\.html$/.test(n)) out.ownerHomes.push(file);
    }
    const pages = path.join(dir, "pages");
    if (names.includes("pages") && fs.statSync(pages).isDirectory()) {
      for (const n of fs.readdirSync(pages)) {
        const m = n.match(/^tabelog_access_ranking-(\d{4}-\d{2})\.html$/);
        if (m) out.rankings.push({ file: path.join(pages, n), month: m[1] });
      }
    }
  }
  return out;
}

/** 作成日より後の取得で使う範囲（assembled.sources の scope） */
export const LATE_SCOPE = "作成日より前の日付の行だけ（日別 PV・作成日の月より前の月別）。公開ページ・予約通知・ランキング・口コミなど取得時点の値は使わない";

/**
 * 作成日より後の取得から「作成日より前の日付がついた行」だけを残した店舗データ。
 * 日別 PV（date < asOf）と、作成日の月より前の月別（確定月）だけ。取得時点のスナップショット
 * （summary・reports〔公開ページ・予約通知・競合・ジャンル順位・ニューオープン・エリアランキング〕・口コミ・一休の公開ページ／クチコミ）は落とす。
 */
export function datedRowsBefore(store, { source, asOf }) {
  const asOfMonth = asOf.slice(0, 7);
  if (source === "tabelog") {
    return {
      storeKey: store.storeKey, name: store.name ?? null,
      daily: (Array.isArray(store.daily) ? store.daily : []).filter((d) => d?.date && d.date < asOf),
      monthly: (Array.isArray(store.monthly) ? store.monthly : []).filter((m) => m?.month && m.month < asOfMonth),
    };
  }
  const months = (store.pageviews?.months ?? []).filter((m) => m?.month && m.month <= asOfMonth).map((m) => {
    const { totals, ...rest } = m;
    // 作成日の月の合計行は作成日以降の日を含むため使わない（日別の合計になる）
    return { ...rest, ...(m.month < asOfMonth && totals ? { totals } : {}), days: (m.days ?? []).filter((d) => d?.date && d.date < asOf) };
  });
  return { storeId: store.storeId, name: store.name ?? null, pageviews: { months } };
}

/**
 * 取り込み JSON を読み、受け付けるものだけ（理由つきで落とす）。
 * 作成日（日本時間）より後の取得は、stub の確認を通ったうえで「作成日より前の日付の行」だけ使う（late: true）。
 * 取得が遅れても（例: 10/6 の取得が止まり 10/7 に取得）、作成日前日までの日別 PV を欠けなく埋めるため。
 */
export function loadPayloads(files, { source, storeKey, asOf }) {
  const accepted = [], rejected = [];
  for (const file of files) {
    let p;
    try { p = readJson(file); } catch { rejected.push({ file, reason: "JSON を読めません" }); continue; }
    if (p?.source !== source) continue;
    const store = (p.stores ?? []).find((s) => String(source === "ikyu" ? s.storeId : s.storeKey) === String(storeKey));
    if (!store) continue;
    const problem = payloadProblem(p); // stub・合成値の確認は取得全体で行う（遅い取得も同じ）
    if (problem) { rejected.push({ file, reason: problem }); continue; }
    const capturedOn = japanDate(p.capturedAt);
    if (capturedOn > asOf) {
      const dated = datedRowsBefore(store, { source, asOf });
      accepted.push({ file, payload: { ...p, stores: [dated] }, store: dated, capturedAt: p.capturedAt, capturedOn, late: true });
      continue;
    }
    accepted.push({ file, payload: p, store, capturedAt: p.capturedAt, capturedOn });
  }
  accepted.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
  return { accepted, rejected };
}

const mtimeOn = (file) => japanDate(fs.statSync(file).mtimeMs);

// ---------- 食べログ ----------
export function assembleTabelogSources({ storeKey, storeName, asOf, payloadFiles = [], ownerHomeFiles = [], rankingFiles = [], options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const cfg = storePublicConfig(storeKey);
  const { accepted, rejected } = loadPayloads(payloadFiles, { source: "tabelog", storeKey, asOf });
  const sources = [], gaps = [], problems = [];
  const fresh = (on, days) => on && daysBetween(on, asOf) <= days;
  const monthly = new Map(), daily = new Map();
  const dailyFrom = new Map(); // date -> 取得（後の取得で上書き）
  const onTimeDates = new Set();
  let reviews = null, name = storeName ?? null;
  const reports = []; // { kind, period, data, capturedAt, capturedOn, file }
  for (const a of accepted) {
    name = name ?? a.store.name ?? null;
    for (const m of Array.isArray(a.store.monthly) ? a.store.monthly : []) if (m?.month && isNum(m.pv)) monthly.set(m.month, m);
    for (const d of Array.isArray(a.store.daily) ? a.store.daily : []) {
      if (!(d?.date && d.date < a.capturedOn && d.date < asOf && isNum(d.pv))) continue;
      daily.set(d.date, d);
      dailyFrom.set(d.date, a);
      if (!a.late) onTimeDates.add(d.date);
    }
    if (a.late) {
      // 作成日より後の取得: 日付つきの行だけ（loadPayloads で取得時点の値は落としてある）
      sources.push({ kind: "payload", file: a.file, capturedAt: a.capturedAt, late: true, scope: LATE_SCOPE, monthly: a.store.monthly.length, daily: a.store.daily.length, reports: [] });
      continue;
    }
    if (Array.isArray(a.store.reviews?.items) && a.store.reviews.items.length) {
      reviews = { items: a.store.reviews.items.map((r) => ({ postedAt: r.postedAt ?? null, rating: isNum(r.rating) ? Number(r.rating) : null })), file: a.file, capturedAt: a.capturedAt };
    }
    for (const r of a.store.reports ?? []) reports.push({ ...r, capturedAt: a.capturedAt, capturedOn: a.capturedOn, file: a.file });
    if (a.store.summary?.saveCount != null) reports.push({ kind: "public_profile", period: a.capturedOn, data: { ...a.store.summary }, capturedAt: a.capturedAt, capturedOn: a.capturedOn, file: a.file, fromSummary: true });
    sources.push({ kind: "payload", file: a.file, capturedAt: a.capturedAt, monthly: (a.store.monthly ?? []).length || 0, daily: Array.isArray(a.store.daily) ? a.store.daily.length : 0, reports: (a.store.reports ?? []).map((r) => r.kind) });
  }
  const notes = [];
  for (const a of accepted.filter((x) => x.late)) {
    const used = [...dailyFrom].filter(([, from]) => from === a).map(([d]) => d).sort();
    const filled = used.filter((d) => !onTimeDates.has(d));
    const src = sources.find((x) => x.file === a.file && x.late);
    if (src) Object.assign(src, { usedDates: used, filledDates: filled });
    if (filled.length) notes.push(`食べログの日別 PV ${filled.join("・")} は作成日より後の取得（${a.capturedOn}・${path.basename(path.dirname(a.file))}）から補いました（日付つきの行だけ。取得時点の公開ページ・通知・ランキング・口コミは使っていません）`);
  }
  const latest = (kind) => reports.filter((r) => r.kind === kind).at(-1) ?? null;
  const latestBatch = (kind) => {
    const rows = reports.filter((r) => r.kind === kind);
    const day = rows.map((r) => r.capturedOn).sort().at(-1);
    return rows.filter((r) => r.capturedOn === day);
  };

  // 月別・日別（必須）
  if (!accepted.length) problems.push("食べログの取り込み JSON（実取得）が見つかりません");
  const months = [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month));
  const curMonth = prevMonth(asOf.slice(0, 7));
  if (!monthly.has(curMonth)) problems.push(`食べログの確定月 ${curMonth} の月別がありません`);
  if (!monthly.has(prevMonth(curMonth))) problems.push(`食べログの前月 ${prevMonth(curMonth)} の月別がありません（前月比が出ません）`);
  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const w = weeklyPvWindows(asOf);
  const missing = [];
  for (let d = w.prior7.from; d <= w.last7.to; d = shiftDate(d, 1)) if (!daily.has(d)) missing.push(d);
  if (missing.length) problems.push(`食べログの日別 PV が欠けています（${missing.slice(0, 5).join("・")}${missing.length > 5 ? " ほか" : ""}）。当日の取得が終わっているか確かめてください`);
  if (looksSynthetic(days.map((d) => d.pv))) problems.push("食べログの日別 PV が合成値に見えます（stub）");
  if (days.length && days.every((d) => d.pvPc == null && d.pvSp == null && d.pvApp == null)) gaps.push("食べログの日別の端末内訳");

  // 口コミ（新着の件数）
  if (!reviews) gaps.push("食べログの口コミ（直近7日の新着件数）");
  else sources.push({ kind: "reviews", file: reviews.file, capturedAt: reviews.capturedAt, count: reviews.items.length });

  // 公開ページ（保存数・予算・駅・評価）
  const prof = latest("public_profile");
  let publicProfile = null;
  if (prof && fresh(prof.capturedOn, opt.maxAgeDays)) {
    const d = prof.data ?? {};
    publicProfile = { rating: d.rating ?? null, reviewCount: d.reviewCount ?? d.reviews ?? null, saveCount: d.saveCount ?? null, budgetNight: d.budgetNight ?? null, budgetDay: d.budgetDay ?? null, station: d.station ?? null };
    sources.push({ kind: "public_profile", file: prof.file, capturedAt: prof.data?.capturedAt ?? prof.capturedAt });
  } else gaps.push(`食べログの公開ページ（評価・保存数・予算・最寄駅）${prof ? `: ${prof.capturedOn} の取得で古い` : ""}`);

  // 予約通知（確認時点の件数）
  let notices = null;
  const nr = latest("reservation_notices");
  const nrOn = nr ? japanDate(nr.data?.capturedAt ?? nr.capturedAt) : null;
  const home = ownerHomeFiles.map((file) => ({ file, on: mtimeOn(file) })).filter((h) => h.on <= asOf).sort((a, b) => a.on.localeCompare(b.on)).at(-1) ?? null;
  if (nr && fresh(nrOn, opt.noticeMaxAgeDays) && (!home || nrOn >= home.on)) {
    notices = { new: nr.data?.new ?? 0, changed: nr.data?.changed ?? 0, cancelled: nr.data?.cancelled ?? 0 };
    sources.push({ kind: "reservation_notices", file: nr.file, capturedAt: nr.data?.capturedAt ?? nr.capturedAt });
  } else if (home && fresh(home.on, opt.noticeMaxAgeDays)) {
    notices = parseOwnerHomeNotices(fs.readFileSync(home.file, "utf8"));
    if (notices) sources.push({ kind: "owner_home", file: home.file, capturedOn: home.on });
  }
  if (!notices) gaps.push(`食べログの新着ご予約情報（管理トップ）${home || nr ? "：直近の取得が無いか古い" : ""}`);

  // アクセス数ランキング（確定月の自店順位）
  let accessRanking = null;
  const shop = name ?? cfg?.name;
  const rankFiles = rankingFiles.filter((r) => r.month <= curMonth).sort((a, b) => b.month.localeCompare(a.month) || mtimeOn(b.file).localeCompare(mtimeOn(a.file)));
  for (const r of rankFiles) {
    if (r.month !== curMonth) break;
    const parsed = parseAccessRanking(fs.readFileSync(r.file, "utf8"), shop);
    if (parsed.self) {
      const [y, m] = r.month.split("-");
      accessRanking = { area: parsed.area ?? cfg?.areas?.[0]?.areaLabel ?? null, self: { rank: parsed.self.rank, pv: parsed.self.pv }, momPct: parsed.self.momPct, competitorsNote: `${y}年${Number(m)}月（確定月）アクセス数ランキング` };
      const savedOn = mtimeOn(r.file);
      // 確定月（作成日の月より前）の順位なので、作成日より後に保存した HTML でも使う（保存日を残す）
      sources.push({ kind: "access_ranking", file: r.file, month: r.month, savedOn, ...(savedOn > asOf ? { late: true } : {}) });
      break;
    }
  }
  if (!accessRanking) {
    const ar = reports.filter((r) => r.kind === "area_ranking" && r.data?.self).at(-1);
    if (ar && fresh(ar.capturedOn, opt.maxAgeDays)) {
      accessRanking = { area: ar.data.area ?? null, self: { rank: ar.data.self.rank, pv: ar.data.self.pv }, momPct: ar.data.self.momPct ?? null, competitorsNote: `アクセス数ランキング（更新日 ${ar.data.updatedAt ?? ar.period}）` };
      sources.push({ kind: "area_ranking", file: ar.file, capturedAt: ar.capturedAt });
    } else gaps.push(`食べログのアクセス数ランキング（${curMonth} の自店順位）`);
  }

  // 公開一覧（競合・ジャンル順位・ニューオープン）
  const primary = cfg?.areas?.[0] ?? null;
  const genreRows = latestBatch("public_genre_ranking").filter((r) => fresh(r.capturedOn, opt.maxAgeDays));
  const compRow = latest("public_competitors");
  const cap = cfg?.competitorCap ?? 5;
  const toComp = (e) => ({ name: e.name, rating: e.rating ?? null, reviews: e.reviews ?? null, saveCount: e.saveCount ?? null, budgetNight: e.budgetNight ?? null, budgetDay: e.budgetDay ?? null, station: e.station ?? null });
  let compEntries = compRow && fresh(compRow.capturedOn, opt.maxAgeDays) ? compRow.data?.entries ?? [] : null;
  let compFrom = compEntries ? compRow : null;
  if (!compEntries) {
    const g = genreRows.find((r) => r.data?.areaKey === primary?.areaKey) ?? genreRows[0];
    if (g) { compEntries = g.data?.entries ?? []; compFrom = g; }
  }
  const competitors = compEntries
    ? [...compEntries.filter((e) => String(e.storeId ?? "") !== String(storeKey)).slice(0, cap).map(toComp), ...(publicProfile ? [{ name: shop, rating: publicProfile.rating, reviews: publicProfile.reviewCount, saveCount: publicProfile.saveCount, budgetNight: publicProfile.budgetNight, budgetDay: publicProfile.budgetDay, station: publicProfile.station, own: true }] : [])]
    : [];
  if (compFrom) sources.push({ kind: "competitors", file: compFrom.file, capturedAt: compFrom.capturedAt });
  else gaps.push("食べログの競合（エリア×ジャンルの評価上位）");

  const areaLabel = primary?.areaLabel ?? compRow?.data?.area ?? accessRanking?.area ?? null;
  const genreRanks = genreRows.filter((r) => !primary || r.data?.areaKey === primary.areaKey).map((r) => ({
    label: `${r.data.area}×${r.data.genre} ランキング`, rank: r.data.selfRank ?? null,
    note: r.data.selfRank != null ? "広告枠を除く掲載順" : `上位${r.data.totalOrganic ?? r.data.entries?.length ?? ""}件に掲載なし（広告枠を除く）`,
  }));
  if (genreRanks.length) sources.push({ kind: "genre_ranks", file: genreRows[0].file, capturedAt: genreRows[0].capturedAt, rows: genreRanks.length });
  else gaps.push("食べログのエリア×ジャンル順位");

  const openRows = latestBatch("public_new_opens").filter((r) => fresh(r.capturedOn, opt.maxAgeDays));
  const seen = new Set();
  const newOpens = openRows.flatMap((r) => (r.data?.entries ?? []).map((e) => ({ areaLabel: r.data.area, genreLabel: r.data.genre, name: e.name, openedOn: e.openedOn ?? null, key: `${r.data.area}|${e.storeId ?? e.name}` })))
    .filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)))
    .sort((a, b) => String(b.openedOn ?? "").localeCompare(String(a.openedOn ?? "")))
    .map(({ key: _k, ...e }) => e);
  if (newOpens.length) sources.push({ kind: "new_opens", file: openRows[0].file, capturedAt: openRows[0].capturedAt, rows: newOpens.length });
  else gaps.push("食べログのニューオープン一覧");

  const input = {
    storeKey: String(storeKey), storeName: name ?? cfg?.name ?? "店舗", asOf,
    monthlyRows: months, dailyRows: days, reviews: reviews ? reviews.items : null,
    publicProfile, notices, accessRanking, competitors, genreRanks, newOpens, areaLabel,
  };
  // 描画と同じ組み立てで最終確認（例外 = 入力の不整合）
  try { assembleWeeklyReportInput(input); } catch (error) { problems.push(`食べログの入力を組み立てられません: ${error.message}`); }
  return { input, sources, rejected, gaps, problems, notes, knownGaps: KNOWN_GAPS.tabelog };
}

// ---------- 一休 ----------
export function assembleIkyuSources({ storeKey, storeName, asOf, payloadFiles = [], options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const { accepted, rejected } = loadPayloads(payloadFiles, { source: "ikyu", storeKey, asOf });
  const gaps = [], problems = [];
  if (!accepted.length) problems.push("一休の取り込み JSON（実取得）が見つかりません");
  let input = null;
  try {
    input = assembleIkyuWeeklyInput({ storeKey: String(storeKey), storeName, asOf, payloads: accepted.map((a) => a.payload) });
  } catch (error) { problems.push(`一休の入力を組み立てられません: ${error.message}`); }
  if (input) {
    if (!isNum(input.monthly?.cur?.pv)) problems.push("一休の確定月の月別がありません");
    if (!isNum(input.monthly?.prev?.pv)) problems.push("一休の前月の月別がありません（前月比が出ません）");
    const days = input.daily ?? [];
    const last = days.filter((d) => isNum(d.pv)).map((d) => d.date).at(-1);
    // 一休は前日分が管理画面に未反映のことがある（1〜2日の遅れは週報側で締め日を動かす）
    if (!last || last < shiftDate(asOf, -3)) problems.push(`一休の日別 PV が古いです（最後の日 ${last ?? "なし"}）。当日の取得が終わっているか確かめてください`);
    else {
      const have = new Set(days.map((d) => d.date));
      const miss = [];
      for (let d = shiftDate(last, -13); d <= last; d = shiftDate(d, 1)) if (!have.has(d)) miss.push(d);
      if (miss.length) problems.push(`一休の日別 PV が欠けています（${miss.slice(0, 5).join("・")}）`);
    }
    if (looksSynthetic(days.map((d) => d.pv))) problems.push("一休の日別 PV が合成値に見えます（stub）");
    const pub = input.publicProfile ?? {};
    if (!isNum(pub.rating)) gaps.push("一休の公開評価・口コミ数（公開ページ）");
    else if (pub.capturedOn && daysBetween(pub.capturedOn, asOf) > opt.ikyuPublicMaxAgeDays) gaps.push(`一休の公開評価が古い（${pub.capturedOn} の取得）`);
    if (!input.ownerReviews) gaps.push("一休の管理画面クチコミ（件数・要返信・新着）");
  }
  const keptDays = (a) => (a.store.pageviews?.months ?? []).flatMap((m) => m.days ?? []).filter((d) => d?.date && d.date < asOf && d.date < a.capturedOn && isNum(d.pv)).map((d) => d.date);
  const onTime = new Set(accepted.filter((a) => !a.late).flatMap(keptDays));
  const notes = [];
  const sources = accepted.map((a) => {
    const base = { kind: "payload", file: a.file, capturedAt: a.capturedAt, months: (a.store.pageviews?.months ?? []).map((m) => m.month), reviews: !!a.store.reviews, public: !!a.store.public };
    if (!a.late) return base;
    const filled = [...new Set(keptDays(a))].filter((d) => !onTime.has(d)).sort();
    if (filled.length) notes.push(`一休の日別 PV ${filled.join("・")} は作成日より後の取得（${a.capturedOn}・${path.basename(path.dirname(a.file))}）から補いました（日付つきの行だけ。取得時点の公開ページ・クチコミは使っていません）`);
    return { ...base, late: true, scope: LATE_SCOPE, filledDates: filled };
  });
  return { input, sources, rejected, gaps, problems, notes, knownGaps: KNOWN_GAPS.ikyu };
}

/** 入力 JSON に付ける出どころ（weekly-deliver --send が確認する） */
export function assembledStamp({ site, asOf, result, allowGaps = false, now = new Date() }) {
  return {
    by: ASSEMBLER, version: ASSEMBLER_VERSION, site, asOf, at: now.toISOString(), allowGaps,
    problems: result.problems, gaps: result.gaps, knownGaps: result.knownGaps, notes: result.notes ?? [],
    sources: result.sources.map((s) => ({ ...s, file: s.file ? path.resolve(s.file) : undefined })),
    rejected: result.rejected.map((r) => ({ file: path.resolve(r.file), reason: r.reason })),
  };
}

/** --send してよい入力か（理由の配列。空 = よい） */
export function sendBlockers(raw, { asOf } = {}) {
  const a = raw?.assembled;
  if (!a || a.by !== ASSEMBLER) return ["scripts/weekly-assemble.mjs で作った入力ではありません（手書き・stub の入力は送りません）"];
  const out = [];
  if (asOf && a.asOf !== asOf) out.push(`作成日が違います（入力 ${a.asOf} / 週報 ${asOf}）`);
  if (a.problems?.length) out.push(...a.problems);
  if (a.gaps?.length && !a.allowGaps) out.push(`足りない項目があります（取り直すか --allow-gaps で組み立て直す）: ${a.gaps.join(" / ")}`);
  return out;
}
