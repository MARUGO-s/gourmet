import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSourceIngest, overlayDetails, mergeReviews, sourceReviewRow, checkMetricRow } from "../../supabase/functions/_shared/source-ingest.js";

const TODAY = "2026-09-29";
const august = () => Array.from({ length: 31 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, pv: 10, pvSp: 6, pvPc: 4, reservations: 1, reservationAmount: 5000 }));
const base = (store = {}) => ({ schemaVersion: 1, source: "hotpepper", runId: "hp-20260929-1", agent: "grok-bot", capturedAt: "2026-09-29T09:00:00+09:00",
  stores: [{ storeKey: "J000123", name: "店A", daily: august(), ...store }] });

test("common payloads normalize to DB columns; null stays null and today onward is skipped", () => {
  const p = base({ daily: [...august(), { date: "2026-09-28", pv: 3 }, { date: "2026-09-29", pv: 9 }, { date: "2026-09-30", pv: null }] });
  const n = normalizeSourceIngest(p, TODAY);
  assert.equal(n.source, "hotpepper");
  assert.equal(n.skippedDays, 2);
  const [s] = n.stores;
  assert.equal(s.days.length, 32);
  assert.deepEqual(s.days.at(-1), { date: "2026-09-28", pv: 3, pv_sp: null, pv_pc: null, pv_app: null, pv_other: null, reservations: null, reservation_amount: null, covers: null, visits: null, calls: null, extra: {} });
  assert.equal(n.run.status, "ok");
  assert.match(n.run.message, /2日分は集計中/);
  assert.equal(n.run.summary_date, TODAY);
});

test("a complete past month without monthly rows is derived from daily rows (never overriding explicit months)", () => {
  const n = normalizeSourceIngest(base(), TODAY);
  const [m] = n.stores[0].months;
  assert.equal(m.month, "2026-08"); assert.equal(m.derived, true); assert.equal(m.complete, true);
  assert.equal(m.reservations, 31); assert.equal(m.reservation_amount, 155000); assert.equal(m.pv, 310);
  const explicit = normalizeSourceIngest(base({ monthly: [{ month: "2026-08", reservations: 40 }, { month: "2026-09", reservations: 3 }] }), TODAY);
  assert.deepEqual(explicit.stores[0].months.map((x) => [x.month, x.derived, x.complete, x.reservations]), [["2026-08", false, true, 40], ["2026-09", false, false, 3]]);
  const partial = normalizeSourceIngest(base({ daily: august().slice(1) }), TODAY);
  assert.equal(partial.stores[0].months.length, 0, "欠けた日がある月は作らない");
});

test("device breakdown, counts, dates and extras are validated", () => {
  assert.doesNotThrow(() => checkMetricRow({ pv: 10, pvSp: 6, pvPc: 4 }, "x"));
  assert.doesNotThrow(() => checkMetricRow({ pv: 10, pvSp: 6, pvPc: 3, pvApp: 0, pvOther: 1 }, "x"));
  for (const bad of [{ pv: 10, pvSp: 7, pvPc: 4 }, { pv: 10, pvSp: 6, pvPc: 3, pvOther: 0 }, { pv: -1 }, { pv: 1.5 }, { calls: "3" }, { extra: { "bad key": 1 } }, { extra: { mapPrints: -1 } }]) {
    assert.throws(() => checkMetricRow(bad, "x"), undefined, JSON.stringify(bad));
  }
  const mutations = [
    (p) => { p.schemaVersion = 2; }, (p) => { p.source = "ikyu"; }, (p) => { p.source = "unknown"; }, (p) => { p.runId = "bad id"; },
    (p) => { p.stores[0].daily[0].date = "2026-02-30"; }, (p) => { p.stores[0].daily.push({ ...p.stores[0].daily[0] }); },
    (p) => { p.stores.push({ ...p.stores[0] }); }, (p) => { p.stores[0].storeKey = "店"; }, (p) => { p.stores[0].monthly = [{ month: "2026-10" }]; },
    (p) => { p.stores[0].summary = { rating: 5.1 }; }, (p) => { p.requestId = "x"; }, (p) => { p.stores = []; },
    (p) => { p.stores[0].reports = [{ kind: "big", period: "2026-09", data: { s: "x".repeat(200_001) } }]; },
  ];
  for (const change of mutations) { const p = base(); change(p); assert.throws(() => normalizeSourceIngest(p, TODAY)); }
  assert.throws(() => normalizeSourceIngest(base({ daily: [{ date: "2026-09-29", pv: 1 }] }), TODAY), /保存できるデータがありません/);
});

test("reviews keep their site identifier, two-decimal ratings, and a derived reply need", () => {
  const n = normalizeSourceIngest(base({ daily: [], reviews: { total: 2, items: [
    { externalId: "HP-1", rating: 4.456, text: "美味しい", author: "a", postedAt: "2026-09-01", scores: [{ label: "料理", value: 4.444 }] },
    { externalId: "HP-2", rating: 3, text: "普通", reply: { text: "ありがとうございました", date: "2026-09-03" }, details: { url: "https://evil.invalid/", lang: "ja" } },
  ] } }), TODAY);
  const [a, b] = n.stores[0].reviews;
  assert.equal(a.rating, 4.46); assert.equal(a.scores[0].value, 4.44); assert.equal(a.needs_reply, true); assert.equal(a.visit_month, null);
  assert.equal(b.needs_reply, false); assert.equal(b.reply_date, "2026-09-03");
  assert.deepEqual(b.details, { lang: "ja" }, "送信側のURLは保存しない");
  const dup = base({ reviews: { total: 2, items: [{ externalId: "X", text: "" }, { externalId: "X", text: "" }] } });
  assert.throws(() => normalizeSourceIngest(dup, TODAY), /重複/);
  assert.throws(() => normalizeSourceIngest(base({ reviews: { total: 1, items: [{ externalId: "X", rating: 6 }] } }), TODAY), /点数/);
});

test("a summary alone is enough to record current rating and review count", () => {
  const n = normalizeSourceIngest({ ...base(), source: "google", stores: [{ storeKey: "", summary: { rating: 4.2, reviewCount: 311 } }] }, TODAY);
  assert.equal(n.stores[0].rating, 4.2); assert.equal(n.stores[0].review_count, 311); assert.equal(n.stores[0].store_key, "");
});

test("warnings make the run partial", () => {
  assert.equal(normalizeSourceIngest({ ...base(), warning: "口コミは未取得" }, TODAY).run.status, "partial");
});

test("ingested reviews replace legacy rows with the same identifier; others remain", () => {
  const legacy = [{ id: "1", source: "tabelog", external_id: "B1:11", text: "旧" }, { id: "2", source: "tabelog", external_id: null, text: "旧抜粋" }, { id: "3", source: "tabelog", external_id: "B9:1", text: "旧のみ" }];
  const ingested = [sourceReviewRow({ source: "tabelog", store_key: "13245351", external_id: "B1:11", text: "新", rating: "3.47", scores: [], needs_reply: null }, "店")];
  const merged = mergeReviews(legacy, ingested);
  assert.deepEqual(merged.map((r) => r.text), ["新", "旧抜粋", "旧のみ"]);
  assert.equal(merged[0].rating, 3.47);
  assert.equal(merged[0].details.storeName, "店");
  assert.equal("needsReply" in merged[0].details, false);
});

test("Tabelog details overlay ingested metrics on legacy reports (summed across stores)", () => {
  const legacy = { ranking: { area: "旧" }, topPages: null, monthly: [{ month: "2026-06", reservations: 5 }], deviceDaily: { "2026-06-01": { pc: 1, sp: 2, app: 3 } } };
  const out = overlayDetails(legacy, {
    daily: [{ date: "2026-09-01", pv_pc: 1, pv_sp: 2, pv_app: 3, pv_other: 1 }, { date: "2026-09-01", store_key: "b", pv_pc: 10, pv_sp: 20, pv_app: 0, pv_other: 0 }, { date: "2026-09-02", pv_pc: null, pv_sp: null, pv_app: null }],
    monthly: [{ month: "2026-08", reservations: 9, calls: null, pv: 100, pv_pc: 10, pv_sp: 80, pv_app: 10, pv_other: 0, extra: { mapPrints: 2 } }],
    reports: [{ kind: "area_ranking", period: "2026-09-01", updated_at: "2026-09-01T00:00:00Z", data: { area: "古" } }, { kind: "area_ranking", period: "2026-09-28", updated_at: "2026-09-28T00:00:00Z", data: { area: "銀座" } }],
  });
  assert.deepEqual(out.deviceDaily["2026-09-01"], { pc: 11, sp: 22, app: 3, unclassified: 1 });
  assert.equal(out.deviceDaily["2026-09-02"], undefined);
  assert.deepEqual(out.deviceDaily["2026-06-01"], { pc: 1, sp: 2, app: 3 });
  assert.deepEqual(out.monthly.map((m) => m.month), ["2026-08", "2026-06"]);
  assert.equal(out.monthly[0].mapPrints, 2); assert.equal(out.monthly[0].calls, null);
  assert.equal(out.ranking.area, "銀座");
});

test("README example payloads pass the same validation as agent-api", async () => {
  const fs = await import("node:fs");
  const { normalizeIkyuIngest } = await import("../../supabase/functions/_shared/ikyu-data.js");
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('"schemaVersion"'));
  assert.ok(blocks.length >= 3);
  for (const block of blocks) {
    const payload = JSON.parse(block);
    if (payload.source === "ikyu") assert.ok(normalizeIkyuIngest(payload, "2026-09-29").stores.length);
    else assert.ok(normalizeSourceIngest(payload, "2026-09-29").stores.length);
  }
});
