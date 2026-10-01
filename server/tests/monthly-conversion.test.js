// 月別のPV・予約とコンバージョン率（get_monthly_conversion）と、鮮度の行の日別・月別の期間。
// 2026-10-01 20:46 の M-talk の回答「食べログの月別コンバージョン率は、必要な月別PVが取得できないため算出できません」の再発防止。
// 数値は本番の取り込み（BISTRO CAVACAVA、食べログ 13245351・一休 112789）と同じ。
import test from "node:test";
import assert from "node:assert/strict";
import { AI_TOOLS, CONVERSION_FORMULA, runTool, systemPrompt } from "../../supabase/functions/_shared/ai-analyst.js";
import { buildEvidence, verifyAnswer } from "../../supabase/functions/_shared/answer-verify.js";
import { coveredLabel, formatFreshness, freshnessSystemMessage, loadFreshness, summarizeFreshness } from "../../supabase/functions/_shared/data-freshness.js";

const NOW = Date.parse("2026-10-01T11:46:00Z");
const CAVA = "11111111-1111-4111-8111-111111111111";
const tabelogMonth = (month, pv, reservations, calls) => ({ source: "tabelog", key: "13245351", month, complete: true, derived: false, pv, pvPc: null, pvSp: null, pvApp: null, pvOther: 0, reservations, calls, mapPrints: 0 });
const ds = {
  today: "2026-10-01",
  stores: [{ id: CAVA, name: "BISTRO CAVACAVA", sort_order: 1 }],
  sites: [{ store_id: CAVA, source: "ikyu", site_store_key: "112789" }, { store_id: CAVA, source: "tabelog", site_store_key: "13245351" }],
  // 日別は 8/1〜（食べログ）だけ。7月は月別の記録にしか無い
  daily: [
    { source: "tabelog", key: "13245351", date: "2026-08-01", pv: 4624 },
    { source: "tabelog", key: "13245351", date: "2026-09-01", pv: 4753 },
  ],
  legacy: [], current: [], reviews: [],
  monthly: [
    { source: "tabelog", key: "13245351", month: "2026-07", pv: 5382, reservations: 9 },
    { source: "tabelog", key: "13245351", month: "2026-08", pv: 4624, reservations: 15 },
    { source: "tabelog", key: "13245351", month: "2026-09", pv: 4753, reservations: 14 },
    { source: "ikyu", key: "112789", month: "2026-08", pv: 398, reservations: 3 },
    { source: "ikyu", key: "112789", month: "2026-09", pv: 719, reservations: 8 },
  ],
  sourceMonthly: [tabelogMonth("2026-06", 5773, 30, 9), tabelogMonth("2026-07", 5382, 9, 9), tabelogMonth("2026-08", 4624, 15, 11), tabelogMonth("2026-09", 4753, 14, 5)],
  sourceDaily: [],
  ikyuMonthly: [
    { key: "112789", month: "2026-08", complete: true, days: 31, pv: 398, sp: 281, pc: 117, reservations: 3, amount: 72000 },
    { key: "112789", month: "2026-09", complete: true, days: 30, pv: 719, sp: 455, pc: 264, reservations: 8, amount: 190800 },
    { key: "112789", month: "2026-10", complete: false, days: 0, pv: null, sp: null, pc: null, reservations: null, amount: null },
  ],
  ikyuDaily: [
    { key: "112789", date: "2026-07-30", pv: 10, reservations: 1, amount: 20000 },
    { key: "112789", date: "2026-07-31", pv: 20, reservations: 0, amount: 0 },
  ],
  reports: [], freshness: [],
};
const ctx = { store: CAVA, from: "2026-09-01", to: "2026-09-30" };
const call = (name, args = {}) => JSON.parse(runTool(ds, name, args, ctx));

test("get_monthly_conversion: Tabelog monthly PV and net reservations → reservations ÷ PV × 100, computed on the server", () => {
  assert.ok(AI_TOOLS.some((t) => t.function.name === "get_monthly_conversion"));
  const r = call("get_monthly_conversion", { source: "tabelog", from_month: "2026-07", to_month: "2026-09" });
  assert.equal(r.formula, CONVERSION_FORMULA);
  assert.match(r.formula, /予約 ÷ PV × 100/);
  const t = r.bySite["食べログ"];
  assert.match(t.basis, /アクセス数レポートの月別PV/);
  assert.match(t.basis, /ネット予約組数/);
  assert.deepEqual(t.rows.map(({ month, pv, reservations, conversionPct }) => ({ month, pv, reservations, conversionPct })), [
    { month: "2026-07", pv: 5382, reservations: 9, conversionPct: 0.17 },
    { month: "2026-08", pv: 4624, reservations: 15, conversionPct: 0.32 },
    { month: "2026-09", pv: 4753, reservations: 14, conversionPct: 0.29 },
  ]);
  assert.deepEqual(t.total, { months: 3, pv: 14759, reservations: 38, conversionPct: 0.26 });
  assert.equal(t.missingMonths, undefined);
  assert.deepEqual(r.sites, ["食べログ"]);
});

test("get_monthly_conversion: Ikyu uses the monthly record, falls back to the daily sum (with days) and never divides by 0 / null", () => {
  const r = call("get_monthly_conversion", { source: "ikyu", from_month: "2026-07", to_month: "2026-10" });
  const i = r.bySite["一休.comレストラン"];
  assert.match(i.basis, /受付日ベース/);
  assert.deepEqual(i.rows.map(({ month, pv, reservations, conversionPct, basis }) => ({ month, pv, reservations, conversionPct, basis })), [
    { month: "2026-07", pv: 30, reservations: 1, conversionPct: 3.33, basis: "日別の合計" },
    { month: "2026-08", pv: 398, reservations: 3, conversionPct: 0.75, basis: "月別の記録" },
    { month: "2026-09", pv: 719, reservations: 8, conversionPct: 1.11, basis: "月別の記録" },
  ], "10月（値なし）は入れない");
  assert.equal(i.rows[0].days, 2);
  assert.deepEqual(i.missingMonths, ["2026-10"], "値の無い月は「わかりません」として示す");
  const onlyAug = call("get_monthly_conversion", { source: "ikyu", from_month: "2026-06", to_month: "2026-06" });
  assert.match(onlyAug.notes.join(" "), /2026-06〜2026-06 の月別のPV・予約の記録はありません/);
  assert.equal(i.rows[0].complete, false, "2日分だけの月は集計途中");
  const none = call("get_monthly_conversion", { source: "ikyu", from_month: "2025-01", to_month: "2025-02" });
  assert.match(none.notes.join(" "), /一休.comレストラン: 2025-01〜2025-02 の月別のPV・予約の記録はありません/);
  const zero = JSON.parse(runTool({ ...ds, sourceMonthly: [tabelogMonth("2020-01", 0, 0, 0)] }, "get_monthly_conversion", { source: "tabelog", from_month: "2020-01", to_month: "2020-01" }, ctx));
  assert.equal(zero.bySite["食べログ"].rows[0].conversionPct, null, "PV 0 の月は率なし");
});

test("monthly PV for July is available (get_monthly_metrics) even though daily PV starts 8/1; get_pv_trend points to the monthly tools", () => {
  const m = call("get_monthly_metrics", { source: "tabelog", from_month: "2026-07", to_month: "2026-09" });
  assert.deepEqual(m.rows.map((x) => [x.month, x.pv, x.reservations]), [["2026-07", 5382, 9], ["2026-08", 4624, 15], ["2026-09", 4753, 14]]);
  const trend = call("get_pv_trend", { source: "tabelog", from: "2026-07-01", to: "2026-09-30", granularity: "month" });
  assert.deepEqual(trend.rows.map((x) => x.period), ["2026-08", "2026-09"], "日別の合計には7月が無い");
  assert.match(trend.note, /get_monthly_metrics/);
  assert.match(trend.note, /get_monthly_conversion/);
  const prompt = systemPrompt("2026-10-01");
  assert.match(prompt, /コンバージョン率・予約率（予約÷PV）は必ず get_monthly_conversion/);
  assert.match(prompt, /率を自分で割り算しない/);
});

test("verifier: the server-computed conversion passes; a self-computed / wrong rate is flagged", () => {
  const result = runTool(ds, "get_monthly_conversion", { source: "tabelog", from_month: "2026-07", to_month: "2026-09" }, ctx);
  const ev = buildEvidence([result]);
  const ok = verifyAnswer("食べログの7月のコンバージョン率は0.17%（ネット予約9組 ÷ 5,382PV × 100）です。", ev);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.equal(verifyAnswer("食べログの8月のコンバージョン率は0.32%、9月は0.29%、3か月合計は0.26%です。", ev).ok, true);
  const bad = verifyAnswer("食べログの7月のコンバージョン率は0.5%です。", ev);
  assert.equal(bad.ok, false);
});

test("freshness footer: shows both the daily and the monthly range of the latest ingest (8/1〜 was only the daily range)", async () => {
  assert.equal(coveredLabel({ from: "2026-08-01", to: "2026-09-30", monthFrom: "2019-12", monthTo: "2026-09" }, 2026), "日別8/1〜9/30・月別2019/12月〜2026/9月");
  assert.equal(coveredLabel({ from: "2026-09-01", to: "2026-09-30" }, 2026), "9/1〜9/30");
  assert.equal(coveredLabel({ monthFrom: "2026-08", monthTo: "2026-09" }, 2026), "8月〜9月");
  // loadFreshness: 同じ取り込みの日別（PVのある行だけ）と月別の範囲
  const ranges = {
    source_daily_metrics: { R2: ["2026-08-01", "2026-09-30"] },
    source_monthly_metrics: { R2: ["2019-12", "2026-09"] },
    ikyu_daily_pageviews: { R1: ["2026-09-01", "2026-09-30"] },
    ikyu_monthly_pageviews: { R1: ["2026-09", "2026-09"] },
  };
  const seen = [];
  const builder = (table, q = []) => new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        seen.push([table, q]);
        let rows = [];
        if (table === "ikyu_ingest_runs") rows = [{ id: "R1", received_at: "2026-10-01T10:09:00Z" }];
        else if (table === "agent_ingest_runs") rows = [{ id: "R2", source: "tabelog", received_at: "2026-10-01T06:28:00Z" }];
        else if (ranges[table]) {
          const run = q.find((c) => c[0] === "eq" && c[1] === "run_id")?.[2];
          const asc = q.find((c) => c[0] === "order")?.[2]?.ascending !== false;
          const d = ranges[table][run];
          const col = table.includes("monthly") ? "month" : "date";
          rows = d ? [{ [col]: asc ? d[0] : d[1] }] : [];
        }
        return (resolve) => resolve({ data: rows, error: null });
      }
      return (...args) => { q.push([prop, ...args]); return builder(table, q); };
    },
  });
  const entries = await loadFreshness({ from: (t) => builder(t) }, { now: NOW });
  assert.equal(formatFreshness(entries, { todayYear: 2026 }), "データ：一休 10/1 19:09取得（日別9/1〜9/30・月別9月）／食べログ 10/1 15:28取得（日別8/1〜9/30・月別2019/12月〜2026/9月）");
  assert.ok(seen.filter(([t]) => /daily|monthly/.test(t)).every(([, q]) => q.some((c) => c[0] === "not" && c[1] === "pv")), "PVのある行だけで範囲を出す");
  const msg = freshnessSystemMessage(summarizeFreshness({ runs: [{ source: "tabelog", receivedAt: "2026-10-01T06:28:00Z", from: "2026-08-01", to: "2026-09-30", monthFrom: "2019-12", monthTo: "2026-09" }], sources: ["tabelog"], now: NOW }), { todayYear: 2026 });
  assert.match(msg, /月別の記録は日別の範囲より前の月にもある/);
  assert.doesNotMatch(msg, /この期間の外の日付・月の数値は取り込まれていない/);
});
