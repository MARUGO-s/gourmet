// 2026-10-05 のアプリ「AI分析」の誤り: 画面で 2026-07-07〜2026-10-04（直近90日）を選んで「評価の低い口コミに共通する不満点は？」と聞くと、
// all_time で全期間（2020〜2024年）の低評価9件を分析し、選択期間（該当0件）と違う期間で答えた。
// 末尾の「データ：…（日別9/1〜10/3）」も最後の1回の取り込みの範囲で、選択期間とも取り込み済みの範囲とも合わなかった。
import test from "node:test";
import assert from "node:assert/strict";
import { askToolContext, asksAllTime, dataCoverage, runTool, systemPrompt } from "../../supabase/functions/_shared/ai-analyst.js";
import { answerFreshness, coverageGaps, summarizeFreshness, withCoverage } from "../../supabase/functions/_shared/data-freshness.js";

const rv = (id, source, rating, date, text = "本文あり", extra = {}) => ({ id, source, rating, date, text, title: "", details: {}, ...extra });
const days = (source, from, to) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) out.push({ source, key: "", date: d, pv: 10 });
  return out;
};
const ds = {
  today: "2026-10-05", stores: [], sites: [], legacy: [], monthly: [], current: [],
  daily: [...days("ikyu", "2025-10-01", "2026-10-04"), ...days("tabelog", "2026-08-01", "2026-10-04")],
  sourceMonthly: [{ source: "tabelog", key: "", month: "2019-12", pv: 1 }, { source: "tabelog", key: "", month: "2026-09", pv: 2 }],
  ikyuMonthly: [{ key: "", month: "2026-09", pv: 3 }, { key: "", month: "2026-10", pv: null }],
  reviews: [
    rv("t1", "tabelog", 4.2, "2026-08-10", "美味しかった"),
    rv("t2", "tabelog", 3.0, "2024-11-17", "提供が遅い"),
    rv("t3", "tabelog", 1.5, "2020-10-23", "対応が残念でした"),
    rv("i1", "ikyu", 4.5, "2026-09-02", "また行きます", { details: { needsReply: true } }),
    rv("i2", "ikyu", 3.5, "2026-07-15", "ワインの量が少なめでした"),
    rv("i3", "ikyu", 2, "2024-02-10", "コースの品数が少ない"),
    rv("i4", "ikyu", 3, "2020-01-26", "接客が残念", { details: { needsReply: true } }),
  ],
  freshness: summarizeFreshness({
    runs: [{ source: "ikyu", receivedAt: "2026-10-05T02:14:00Z", from: "2026-09-01", to: "2026-10-03", monthFrom: "2026-09", monthTo: "2026-10" },
      { source: "tabelog", receivedAt: "2026-10-05T01:50:00Z", from: "2026-09-01", to: "2026-10-04", monthFrom: "2025-09", monthTo: "2026-09" }],
    now: Date.parse("2026-10-05T03:00:00Z"),
  }),
};
const SCREEN = { store: "all", from: "2026-07-07", to: "2026-10-04" };
const ctxFor = (question, history = []) => askToolContext({ ...SCREEN, question, history });
const tool = (ctx, name, args) => JSON.parse(runTool(ds, name, args, ctx));

test("全期間をはっきり求める言い方だけを全期間とみなす", () => {
  for (const q of ["全期間の悪い口コミは？", "これまでの低評価", "今までで一番低い口コミ", "累計の口コミ数", "開店以来の評価", "期間を問わず悪い口コミ"]) assert.equal(asksAllTime(q), true, q);
  for (const q of ["評価の低い口コミに共通する不満点は？", "悪い口コミ", "最新の口コミ", "今月のPV", "未返信の口コミは？", ""]) assert.equal(asksAllTime(q), false, q);
  assert.deepEqual(ctxFor("悪い口コミ"), { ...SCREEN, lockPeriod: true, allowAllTime: false });
  // 直前の質問が全期間なら、続きの質問（「その中で…」）も全期間
  assert.equal(ctxFor("その中で接客の不満は？", [{ role: "user", content: "全期間の悪い口コミは？" }, { role: "assistant", content: "…" }]).allowAllTime, true);
  assert.equal(ctxFor("その中で接客の不満は？", [{ role: "user", content: "悪い口コミは？" }]).allowAllTime, false);
});

test("10/05 の質問: all_time を付けても画面の期間で数え、全期間は参考の件数だけ返す", () => {
  const ctx = ctxFor("評価の低い口コミに共通する不満点は？");
  const r = tool(ctx, "get_reviews", { filter: "low_rating", all_time: true });
  assert.equal(r.period, "2026-07-07 〜 2026-10-04");
  assert.equal(r.matched, 0);
  assert.deepEqual(r.reviews, []);
  assert.match(r.periodNote, /画面で選択中の期間（2026-07-07 〜 2026-10-04）で数えました/);
  assert.deepEqual(r.allTimeReference.bySite, { "食べログ": 2, "一休.comレストラン": 2 });
  assert.equal(r.allTimeReference.matched, 4);
  assert.equal(r.allTimeReference.oldestDate, "2020-01-26");
  assert.equal(r.allTimeReference.latestDate, "2024-11-17");
  assert.ok(!JSON.stringify(r.allTimeReference).includes("接客が残念"), "全期間の口コミの中身は返さない");
  assert.match(r.answerHint, /2026-07-07 〜 2026-10-04では0件/);
  assert.doesNotMatch(r.answerHint, /all_time: true/);

  const st = tool(ctx, "get_review_stats", { all_time: true });
  assert.equal(st.period, "2026-07-07 〜 2026-10-04");
  assert.equal(st.lowRatingCount, 0);
  assert.equal(st.count, 3);
  assert.equal(st.allTimeReference.lowRatingCount, 4);
  assert.ok(st.periodNote);
});

test("質問が全期間をはっきり求めたときは、アプリでも全期間の口コミを返す", () => {
  const r = tool(ctxFor("全期間の評価の低い口コミに共通する不満点は？"), "get_reviews", { filter: "low_rating", all_time: true });
  assert.equal(r.period, "全期間");
  assert.equal(r.matched, 4);
  assert.equal(r.allTimeReference, undefined);
  assert.equal(r.periodNote, undefined);
  assert.ok(r.reviews.some((x) => x.text === "接客が残念"));
});

test("アプリの未返信も画面の期間（全期間の件数は参考）。M-talk（画面の期間なし）は従来どおり全期間", () => {
  const app = tool(ctxFor("未返信の口コミは？"), "get_reviews", { filter: "unreplied" });
  assert.equal(app.period, "2026-07-07 〜 2026-10-04");
  assert.equal(app.matched, 1);
  assert.equal(app.allTimeReference.matched, 2);
  const mtalk = { store: "all", from: "2026-07-07", to: "2026-10-04" };
  assert.equal(tool(mtalk, "get_reviews", { filter: "unreplied" }).period, "全期間");
  const low = tool(mtalk, "get_reviews", { filter: "low_rating", all_time: true });
  assert.equal(low.period, "全期間");
  assert.equal(low.matched, 4);
  assert.equal(low.allTimeReference, undefined);
});

test("プロンプト: アプリは画面の期間（全期間ははっきり求めたときだけ）、M-talk は従来の all_time の指示", () => {
  const app = systemPrompt("2026-10-05", { screenPeriod: true });
  assert.match(app, /期間は画面で選択中の期間を使う（口コミも同じ）/);
  assert.match(app, /参考：全期間では◯件/);
  assert.doesNotMatch(app, /「最新」「悪い口コミ」など全体を聞かれたら、口コミの関数は all_time=true を使う/);
  assert.match(systemPrompt("2026-10-05"), /「最新」「悪い口コミ」など全体を聞かれたら、口コミの関数は all_time=true を使う/);
});

test("取り込み済みの範囲: 最後の1回の取り込み（9/1〜）ではなく、データのある全範囲", () => {
  const cov = dataCoverage(ds, "all");
  assert.deepEqual(cov.ikyu, { from: "2025-10-01", to: "2026-10-04", monthFrom: "2026-09", monthTo: "2026-09" });
  assert.deepEqual(cov.tabelog, { from: "2026-08-01", to: "2026-10-04", monthFrom: "2019-12", monthTo: "2026-09" });
  const entries = withCoverage(ds.freshness, cov);
  assert.equal(entries.find((e) => e.source === "tabelog").from, "2026-08-01");
  assert.equal(withCoverage(ds.freshness, null), ds.freshness);
  const f = tool(ctxFor("データはいつまで？"), "get_data_freshness", {});
  assert.equal(f.bySite.find((x) => x.site === "一休").coveredFrom, "2025-10-01");
});

test("選択期間の日別データの欠けを※の行で書く", () => {
  const entries = withCoverage(ds.freshness, dataCoverage(ds, "all"));
  assert.deepEqual(coverageGaps(entries, SCREEN, 2026), ["※食べログの日別データは8/1〜10/4です（7/7〜7/31はありません）。"]);
  assert.deepEqual(coverageGaps(entries, { from: "2026-09-01", to: "2026-10-04" }, 2026), []);
  assert.deepEqual(coverageGaps([{ source: "tabelog", label: "食べログ", from: "2026-08-01", to: "2026-09-30" }], { from: "2026-07-07", to: "2026-10-04" }, 2026),
    ["※食べログの日別データは8/1〜9/30です（7/7〜7/31・10/1〜10/4はありません）。"]);
  assert.deepEqual(coverageGaps([{ source: "tabelog", label: "食べログ", from: null, to: null }], SCREEN, 2026), ["※食べログの日別データは7/7〜10/4にはありません。"]);
  assert.deepEqual(coverageGaps(entries, null), []);
});

test("答えの最後の鮮度: 取り込み済みの範囲を書き、日別の数値を使った答えだけ欠けを書く", () => {
  const coverage = dataCoverage(ds, "all");
  const sites = ["一休.comレストラン", "食べログ"];
  const kpi = answerFreshness({ calls: [{ name: "get_kpis", args: {} }], sites }, ds, { todayYear: 2026, coverage, period: SCREEN });
  assert.equal(kpi.text, [
    "データ：一休 10/5 11:14取得（日別2025/10/1〜2026/10/4・月別9月）／食べログ 10/5 10:50取得（日別8/1〜10/4・月別2019/12月〜2026/9月）",
    "※食べログの日別データは8/1〜10/4です（7/7〜7/31はありません）。",
  ].join("\n"));
  // 関数の引数の期間（先月）で欠けを判断する
  const lastMonth = answerFreshness({ calls: [{ name: "get_pv_trend", args: { from: "2026-09-01", to: "2026-09-30" } }], sites }, ds, { todayYear: 2026, coverage, period: SCREEN });
  assert.equal(lastMonth.text.split("\n").length, 1);
  // 口コミだけの答えには日別の欠けを書かない
  const reviews = answerFreshness({ calls: [{ name: "get_reviews", args: {} }], sites }, ds, { todayYear: 2026, coverage, period: SCREEN });
  assert.doesNotMatch(reviews.text, /※/);
  // coverage を渡さない呼び出しは従来どおり（最後の取り込みの範囲）
  assert.match(answerFreshness({ calls: [{ name: "get_kpis", args: {} }], sites }, ds, { todayYear: 2026 }).text, /一休 10\/5 11:14取得（日別9\/1〜10\/3/);
});
