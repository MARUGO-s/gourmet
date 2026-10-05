// 全サイト共通の週報テンプレート（scripts/shared/weekly-report.js）と、食べログ・一休の見た目の同一性。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pickMonthPair, renderWeeklyReportHtml, renderMd, NA } from "../../scripts/shared/weekly-report.js";
import { assembleWeeklyReportInput, buildTabelogWeeklyView, buildWeeklyReportHtml } from "../../scripts/tabelog/weekly-report.js";
import { assembleIkyuWeeklyInput, buildIkyuWeeklyReportHtml } from "../../scripts/ikyu/weekly-report.js";
import { weeklyPvWindows as legacyWindows } from "../../scripts/tabelog/weekly-windows.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const days = (from, n, pv = (i) => 100 + (i % 7) * 10) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), pv: pv(i) };
});

const tabelogRaw = {
  storeKey: "13245351", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05",
  monthlyRows: [{ month: "2026-08", pv: 4624, reservations: 15, calls: 11 }, { month: "2026-09", pv: 4753, reservations: 14, calls: 5 }],
  dailyRows: days("2026-09-05", 30),
  reviews: [],
  publicProfile: { rating: 3.26, reviewCount: 49, saveCount: 4007 },
  competitors: [{ name: "ラトラスフィス", rating: 3.61, reviews: 146 }, { name: "BISTRO CAVA CAVA", rating: 3.26, reviews: 49, own: true }],
};

function minimalView(over = {}) {
  const tab = buildTabelogWeeklyView(assembleWeeklyReportInput({ storeKey: "x", storeName: "テスト店", asOf: "2026-10-05" }));
  return { ...tab, site: { key: "hotpepper", label: "ホットペッパー" }, ...over };
}

// 見た目（UI の骨格）: クラス名の出現回数。サイトごとに同じでなければならない部品。
const CHROME = ["hero", "hero-aside", "kpis", "kpi", "panels", "panel", "chart-area", "segmented", "weekly-rows", "two-col",
  "competitor-rows", "action-grid", "action", "footnote", "footer"];
const chrome = (html) => Object.fromEntries(CHROME.map((c) => [c, (html.match(new RegExp(`class="${c}"`, "g")) ?? []).length]));

test("shared template: site label drives title / topline / data-site; content stays escaped", () => {
  const html = renderWeeklyReportHtml(minimalView({ storeName: "<script>店</script>", hero: { title: ["A&B", "二行目"], points: ["**強調**と<b>生タグ</b>"], focus: "**3件 → 5件** に変化" } }));
  assert.match(html, /<title>【ホットペッパー週報】&lt;script&gt;店&lt;\/script&gt; 2026\/10\/05<\/title>/);
  assert.match(html, /<body data-site="hotpepper">/);
  assert.match(html, /2026\.10\.05 \/ ホットペッパー/);
  assert.match(html, /<strong>強調<\/strong>と&lt;b&gt;生タグ&lt;\/b&gt;/);
  assert.match(html, /<b>3件 → 5件<\/b> に変化/);
  assert.ok(!html.includes("<script>店"), "store name is escaped");
  assert.ok(!/https?:\/\/(?!www\.w3)/.test(html), "offline: no external URLs");
  assert.ok(!/undefined|NaN/.test(html.replace(/<script>[\s\S]*<\/script>/, "")), "no undefined/NaN in markup");
});

test("shared template: missing data renders 未取得 (never blank or 0)", () => {
  const html = renderWeeklyReportHtml(minimalView());
  assert.match(html, /（日別PV：未取得）/);
  assert.match(html, /前週比較：未取得/);
  assert.match(html, /<div class="value">未取得 <span class="unit">PV<\/span><\/div>/);
  assert.equal(NA, "未取得");
  assert.equal(renderMd("<x>**y**"), "&lt;x&gt;<strong>y</strong>");
});

test("tabelog adapter renders through the shared template (thin wrapper, same HTML)", () => {
  const input = assembleWeeklyReportInput(tabelogRaw);
  const html = buildWeeklyReportHtml(input);
  assert.equal(html, renderWeeklyReportHtml(buildTabelogWeeklyView(input)));
  assert.match(html, /【食べログ週報】BISTRO CAVA CAVA/);
  assert.match(html, /data-site="tabelog"/);
  assert.match(html, /食べログ予約専用番号 通話成立数/);
  assert.equal(typeof legacyWindows, "function", "scripts/tabelog/weekly-windows.js still re-exports helpers");
});

test("tabelog and ikyu weekly share the same chrome (hero/KPI/panels/charts/competitor/actions/footnotes)", () => {
  const tab = buildWeeklyReportHtml(assembleWeeklyReportInput(tabelogRaw));
  const ikyu = buildIkyuWeeklyReportHtml(assembleIkyuWeeklyInput({
    storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05",
    monthlyRows: [{ month: "2026-08", complete: true, pv: 398, guide: 358, plan: 40, other: 0, reservations: 3, amount: 72000 },
      { month: "2026-09", complete: true, pv: 719, guide: 628, plan: 91, other: 0, reservations: 8, amount: 190800 }],
    dailyRows: days("2026-09-05", 30),
  }));
  assert.deepEqual(chrome(ikyu), chrome(tab));
  assert.equal(chrome(tab).kpi, 4);
  assert.equal(chrome(tab).action, 3);
  // CSS は共通ファイル 1 つ
  const css = fs.readFileSync(path.join(root, "scripts/shared/weekly-report.css.txt"), "utf8");
  assert.ok(tab.includes(css) && ikyu.includes(css));
  for (const html of [tab, ikyu]) {
    for (const id of ["monthly-bars", "daily-bars", "competitor-rows", "rank-insight", "key-numbers", "action-heading"]) assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("pickMonthPair: consecutive mode refuses to call a gap month 前月", () => {
  const rows = [{ month: "2026-07" }, { month: "2026-09" }, { month: "2026-10" }];
  assert.deepEqual(pickMonthPair(rows, "2026-10-05"), { cur: { month: "2026-09" }, prev: { month: "2026-07" } });
  assert.deepEqual(pickMonthPair(rows, "2026-10-05", { consecutive: true }), { cur: { month: "2026-09" }, prev: null });
  assert.deepEqual(pickMonthPair([{ month: "2026-08" }, ...rows], "2026-10-05", { consecutive: true }).prev, { month: "2026-08" });
});

test("CLI: tabelog wrapper and unified --site tabelog write the same HTML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-"));
  const input = path.join(dir, "in.json");
  fs.writeFileSync(input, JSON.stringify(tabelogRaw));
  execFileSync(process.execPath, [path.join(root, "scripts/tabelog-weekly-report.mjs"), "--input", input, "--out", path.join(dir, "a.html")], { stdio: "pipe" });
  execFileSync(process.execPath, [path.join(root, "scripts/weekly-report.mjs"), "--site", "tabelog", "--input", input, "--out", path.join(dir, "b.html")], { stdio: "pipe" });
  const a = fs.readFileSync(path.join(dir, "a.html"), "utf8");
  assert.equal(a, fs.readFileSync(path.join(dir, "b.html"), "utf8"));
  assert.equal(a, buildWeeklyReportHtml(assembleWeeklyReportInput(tabelogRaw)));
  assert.throws(() => execFileSync(process.execPath, [path.join(root, "scripts/weekly-report.mjs"), "--site", "nope"], { stdio: "pipe" }), /status 2|Command failed/);
});
