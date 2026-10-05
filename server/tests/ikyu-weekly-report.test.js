// 一休週報（scripts/ikyu/weekly-report.js）: 取り込み JSON / DB 行からの組み立て、未取得の扱い、PII、CLI。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assembleIkyuWeeklyInput, buildIkyuWeeklyReportHtml, ikyuDailyAsOf, sumIkyuDaily } from "../../scripts/ikyu/weekly-report.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pvRow = (date, pv, extra = {}) => ({ date, guide: pv - 2, plan: 2, other: 0, sp: pv - 1, pc: 1, pv, reservations: null, amount: null, ...extra });
const monthDays = (month, n, fn) => Array.from({ length: n }, (_, i) => fn(`${month}-${String(i + 1).padStart(2, "0")}`, i));
const totalsOf = (days) => Object.fromEntries(["guide", "plan", "other", "sp", "pc", "pv", "reservations", "amount"].map((k) => [k, days.reduce((a, d) => a + (d[k] ?? 0), 0)]));

function payload({ capturedAt, months, reviews, pub }) {
  return { schemaVersion: 1, source: "ikyu", runId: "t", capturedAt, stores: [{ storeId: "112789", pageviews: { months }, ...(reviews ? { reviews } : {}), ...(pub ? { public: pub } : {}) }] };
}
const aug = monthDays("2026-08", 31, (d, i) => pvRow(d, 10 + (i % 5), i === 3 ? { reservations: 1, amount: 24000 } : {}));
const sep = monthDays("2026-09", 30, (d, i) => pvRow(d, 20 + (i % 7), i === 28 ? { reservations: 2, amount: 50000 } : {}));
// 10/05 取得: 10/04 は管理画面で未反映（null）、10/05 以降は集計中
const oct = monthDays("2026-10", 31, (d, i) => (i < 3 ? pvRow(d, 5 + i, i === 1 ? { reservations: 1, amount: 30000 } : {}) : { ...pvRow(d, 0), pv: null, guide: null, plan: null, other: null, sp: null, pc: null }));
const latest = payload({
  capturedAt: "2026-10-05T02:00:00Z",
  months: [{ month: "2026-09", totals: totalsOf(sep), days: sep }, { month: "2026-10", totals: totalsOf(oct.slice(0, 3)), days: oct }],
  reviews: { total: 2, items: [
    { reservationNo: "R0001", postedAt: "2026-10-01", visitDate: "2026-09-30", handleName: "グルメ太郎", text: "とても美味しかった本文", rating: 4.5, scores: [], title: "", reply: null, processing: null, needsReply: true },
    { reservationNo: "R0002", postedAt: "2026-08-01", visitDate: "2026-07-30", handleName: "花子", text: "また来ます本文", rating: 4, scores: [], title: "", reply: { text: "ありがとうございます", date: "2026-08-02" }, processing: "返信済", needsReply: false },
  ] },
});
const older = payload({ capturedAt: "2026-09-20T02:00:00Z", months: [{ month: "2026-08", totals: totalsOf(aug), days: aug }, { month: "2026-09", totals: null, days: sep.slice(0, 19) }], pub: { rating: 4.38, reviewCount: 4, reviews: [] } });

test("assemble from ingest payloads: consecutive complete months, merge newer over older, PII stripped", () => {
  const input = assembleIkyuWeeklyInput({ storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05", payloads: [latest, older] });
  assert.equal(input.monthly.cur.month, "2026-09");
  assert.equal(input.monthly.prev.month, "2026-08");
  assert.equal(input.monthly.cur.pv, totalsOf(sep).pv);
  assert.equal(input.monthly.cur.reservations, 2);
  assert.equal(input.monthly.prev.amount, 24000);
  assert.equal(input.publicProfile.rating, 4.38);
  assert.equal(input.publicProfile.capturedOn, "2026-09-20");
  assert.deepEqual(input.ownerReviews, { count: 2, needsReply: 1, capturedFrom: "2026-10-05", capturedOn: "2026-10-05" });
  assert.equal(input.newReviews7d, 1, "postedAt 2026-10-01 is within 09/28–10/04");
  assert.ok(!input.daily.some((d) => d.date >= "2026-10-04"), "unreflected 10/04 and 集計中 10/05+ are not rows");
  assert.ok(!JSON.stringify(input).match(/グルメ太郎|花子|R0001|本文/), "no handle names, reservation numbers or review text in the input");
});

test("a partial later capture never overwrites a complete month; gap month is not 前月", () => {
  const partial = payload({ capturedAt: "2026-10-06T02:00:00Z", months: [{ month: "2026-09", totals: null, days: sep.slice(0, 10) }] });
  const input = assembleIkyuWeeklyInput({ storeKey: "112789", asOf: "2026-10-07", payloads: [latest, older, partial] });
  assert.equal(input.monthly.cur.pv, totalsOf(sep).pv);
  const gap = assembleIkyuWeeklyInput({ storeKey: "112789", asOf: "2026-10-05", monthlyRows: [
    { month: "2026-07", complete: true, pv: 600 }, { month: "2026-09", complete: true, pv: 719 },
  ] });
  assert.equal(gap.monthly.cur.month, "2026-09");
  assert.deepEqual(gap.monthly.prev, {}, "2026-07 is not the previous month of 2026-09");
  const html = buildIkyuWeeklyReportHtml(gap);
  assert.match(html, /前月：未取得/);
});

test("DB rows (snake_case from ikyu_*_pageviews) are accepted", () => {
  const input = assembleIkyuWeeklyInput({
    storeKey: "112789", asOf: "2026-10-05",
    monthlyRows: [
      { store_id: "112789", month: "2026-08", complete: true, days: 31, pv: 398, guide_total: 358, plan_total: 40, other_total: 0, sp: 281, pc: 117, reservations: 3, reservation_amount: 72000 },
      { store_id: "112789", month: "2026-09", complete: true, days: 30, pv: "719", guide_total: 628, plan_total: 91, other_total: 0, sp: 455, pc: 264, reservations: 8, reservation_amount: "190800" },
    ],
    dailyRows: [{ store_id: "112789", date: "2026-09-30", pv: 24, plan_total: 6, reservations: 1, reservation_amount: 45000 }],
  });
  assert.equal(input.monthly.cur.amount, 190800);
  assert.equal(input.monthly.cur.plan, 91);
  assert.equal(input.monthly.cur.pv, 719);
  assert.deepEqual(input.daily[0], { date: "2026-09-30", pv: 24, guide: null, plan: 6, other: null, sp: null, pc: null, reservations: 1, amount: 45000 });
});

test("weekly sums: blank reservation cells count as none only when the PV row exists; missing day → 未取得", () => {
  const rows = [pvRow("2026-09-28", 10, { reservations: 1, amount: 1000 }), pvRow("2026-09-29", 10), pvRow("2026-09-30", 10, { reservations: 2, amount: 3000 })];
  assert.equal(sumIkyuDaily(rows, "2026-09-28", "2026-09-30", "reservations"), 3);
  assert.equal(sumIkyuDaily(rows, "2026-09-28", "2026-10-01", "reservations"), null);
  assert.equal(ikyuDailyAsOf([pvRow("2026-10-03", 5)], "2026-10-05"), "2026-10-04", "one-day admin lag moves the cutoff");
  assert.equal(ikyuDailyAsOf([pvRow("2026-09-20", 5)], "2026-10-05"), "2026-10-05", "stale data does not move the cutoff");
  assert.equal(ikyuDailyAsOf([pvRow("2026-10-04", 5)], "2026-10-05"), "2026-10-05");
});

test("ikyu HTML: same chrome, 一休 labels, facts with footnotes, 未取得 for sections without data, no PII", () => {
  const html = buildIkyuWeeklyReportHtml(assembleIkyuWeeklyInput({ storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05", payloads: [latest, older] }));
  assert.match(html, /<title>【一休週報】BISTRO CAVA CAVA 2026\/10\/05<\/title>/);
  assert.match(html, /data-site="ikyu"/);
  for (const cls of ["hero", "kpis", "chart-area", "competitor-rows", "action-grid", "footnote"]) assert.match(html, new RegExp(`class="${cls}"`));
  assert.match(html, /data-metric="amount"/);
  assert.match(html, /受付日ベース/);
  assert.match(html, /管理画面に未反映の2026\/10\/04以降は含めていません/);
  assert.match(html, /直近7日間（09\/27–10\/03）/);
  assert.match(html, /（一休の競合詳細：未取得）/);
  assert.match(html, /エリア内順位<\/td><td class="num">未取得/);
  assert.match(html, /4\.38/);
  assert.match(html, /うち要返信<\/td><td class="num">1</);
  assert.ok(!/グルメ太郎|花子|R0001|R0002|美味しかった|ありがとうございます/.test(html), "no PII / review text");
  assert.ok(!/undefined|NaN/.test(html.replace(/<script>[\s\S]*<\/script>/, "")));
});

test("ikyu HTML with no reviews/public data shows 未取得 instead of 0", () => {
  const html = buildIkyuWeeklyReportHtml(assembleIkyuWeeklyInput({ storeKey: "112789", asOf: "2026-10-05", payloads: [payload({ capturedAt: "2026-10-05T02:00:00Z", months: [{ month: "2026-09", totals: totalsOf(sep), days: sep }] })] }));
  assert.match(html, /一休 店舗112789/, "falls back to the store id when no name is known");
  assert.match(html, /総合評価（公開ページ）<\/td><td class="num">未取得/);
  assert.match(html, /管理画面クチコミ（取り込み済み）<\/td><td class="num">未取得/);
  assert.match(html, /<div class="review-stat"><strong>未取得<\/strong>/);
  assert.match(html, /月次の予約件数・金額|前月：未取得/);
});

test("CLI: ikyu wrapper and unified --site ikyu build from --payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ikyu-weekly-"));
  fs.writeFileSync(path.join(dir, "p1.json"), JSON.stringify(latest));
  fs.writeFileSync(path.join(dir, "p2.json"), JSON.stringify(older));
  const common = ["--payload", path.join(dir, "p1.json"), "--payload", path.join(dir, "p2.json"), "--store", "112789", "--name", "BISTRO CAVA CAVA", "--as-of", "2026-10-05"];
  execFileSync(process.execPath, [path.join(root, "scripts/ikyu-weekly-report.mjs"), ...common, "--out", path.join(dir, "a.html")], { stdio: "pipe" });
  execFileSync(process.execPath, [path.join(root, "scripts/weekly-report.mjs"), "--site", "ikyu", ...common, "--out", path.join(dir, "b.html")], { stdio: "pipe" });
  const a = fs.readFileSync(path.join(dir, "a.html"), "utf8");
  assert.equal(a, fs.readFileSync(path.join(dir, "b.html"), "utf8"));
  assert.match(a, /【一休週報】BISTRO CAVA CAVA/);
  assert.throws(() => execFileSync(process.execPath, [path.join(root, "scripts/ikyu-weekly-report.mjs"), "--store", "12"], { stdio: "pipe" }));
});
