import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_IDS } from "../../supabase/functions/_shared/sources.js";
import { validateSourceSelection, selectAnalystSources } from "../../supabase/functions/_shared/ai-source-scope.js";
import { validateAskInput, validateReportInput, askToolContext, runTool, contextMessage, buildReportFacts, composeReportMarkdown } from "../../supabase/functions/_shared/ai-analyst.js";

const ds = { today: "2026-10-07", stores: [], sites: [], legacy: [],
 daily: [{ source: "tabelog", key: "a", date: "2026-10-01", pv: 10 }, { source: "ikyu", key: "112789", date: "2026-10-01", pv: 900 }],
 monthly: [], current: [], reviews: [{ id: "x", source: "ikyu", date: "2026-10-01", text: "excluded private review", rating: 1, details: {} }],
 reports: [{ source: "ikyu", kind: "public_profile", data: { name: "excluded profile" } }],
 freshness: [{ source: "ikyu", storeId: "112789" }], ikyuDaily: [{ key: "112789", amount: 999999 }], ikyuMonthly: [{ key: "112789", pv: 777777 }] };
const input = { question: "全サイトのPVと口コミ", from: "2026-10-01", to: "2026-10-06", storeId: "all", sources: ["tabelog"] };
test("source selection validates requests, defaults to all, and rejects empty/unknown/duplicate lists", () => {
 assert.deepEqual(validateSourceSelection(undefined), SOURCE_IDS);
 for (const sources of [[], ["all"], ["ikyu", "ikyu"], "tabelog", [null]]) {
  assert.throws(() => validateAskInput({ ...input, sources }, ds.today), /サイト/);
  assert.throws(() => validateReportInput({ ...input, sources }, ds.today), /サイト/);
 }
 assert.deepEqual(validateAskInput(input, ds.today).sources, ["tabelog"]);
 assert.deepEqual(validateReportInput(input, ds.today).sources, ["tabelog"]);
});
test("every loaded data family is filtered, without changing the original dataset", () => {
 const full = { ...ds, sourceDaily: ds.daily, sourceMonthly: ds.daily, current: ds.daily, monthly: ds.daily, legacy: ds.daily, sites: ds.daily };
 const scoped = selectAnalystSources(full, ["tabelog"]);
 for (const key of ["daily", "sites", "sourceDaily", "sourceMonthly", "legacy", "current", "monthly"]) assert.deepEqual(scoped[key].map(r => r.source), ["tabelog"]);
 for (const key of ["reviews", "reports", "freshness", "ikyuDaily", "ikyuMonthly"]) assert.equal(scoped[key].length, 0);
 assert.equal(full.daily.length, 2);
 assert.equal(selectAnalystSources(full).daily.length, 2);
});
test("tool overrides and special tools cannot retrieve an excluded site", () => {
 const validated = validateAskInput(input, ds.today), ctx = askToolContext(validated);
 const kpi = JSON.parse(runTool(ds, "get_kpis", {}, ctx));
 assert.equal(kpi.total.pv, 10);
 assert.deepEqual(kpi.sites, ["食べログ"]);
 const overridden = JSON.parse(runTool(ds, "get_kpis", { source: "ikyu" }, ctx));
 assert.deepEqual(overridden.sites, []);
 for (const name of ["get_reviews", "get_public_profile", "get_data_freshness", "get_reservation_sales", "get_pv_breakdown", "get_site_reports", "compare_stores", "list_stores"]) {
  const text = runTool(ds, name, { source: "all" }, ctx);
  assert.doesNotMatch(text, /excluded|999999|777777/);
 }
 const context = contextMessage(ds, validated);
 assert.match(context, /分析対象サイト: 食べログ/);
 assert.doesNotMatch(context, /900|excluded/);
});
test("reports and their saved target summary use the same selected sources", () => {
 const facts = buildReportFacts(ds, validateReportInput(input, ds.today));
 assert.deepEqual(facts.sources, ["tabelog"]);
 assert.equal(facts.kpis.total.pv, 10);
 assert.equal(facts.reviewStats.count, 0);
 const md = composeReportMarkdown(facts, { summary: [], positiveThemes: [], negativeThemes: [], recommendations: [] });
 assert.match(md, /対象サイト: 食べログ/);
 assert.doesNotMatch(md, /excluded|900/);
 assert.equal(buildReportFacts(ds, validateReportInput({ ...input, sources: undefined }, ds.today)).kpis.total.pv, 910);
});
