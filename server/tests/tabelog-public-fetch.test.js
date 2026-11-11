import test from "node:test";
import assert from "node:assert/strict";
import { validateTabelogResult } from "../../scripts/tabelog/validate.js";
import { publicFetchPlan } from "../../scripts/tabelog/store-config.js";
import {
  buildPublicOnlyPayload,
  isBlockedPublicPage,
  isIgnoredGenreList,
  pageTitle,
  PUBLIC_ONLY_WARNING,
} from "../../scripts/tabelog/public-payload.js";
import { normalizeSourceIngest } from "../../supabase/functions/_shared/source-ingest.js";
import { assertTabelogUrl, defaultOutDir } from "../../scripts/tabelog/public-fetch.mjs";
import { assembleTabelogSources } from "../../scripts/shared/weekly-sources.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const entry = (storeId, name, rank, extra = {}) => ({
  storeId, name, rank, rating: 3.5, reviews: 10, saveCount: 100, budgetNight: "¥8,000–¥9,999", budgetDay: null, station: "曙橋駅", ...extra,
});

function sampleParsed() {
  const homeEntries = [
    entry("11111111", "競合A", 1),
    entry("22222222", "競合B", 2),
    entry("13245351", "BISTRO CAVA CAVA", 3),
    entry("33333333", "競合C", 4),
    entry("44444444", "競合D", 5),
    entry("55555555", "競合E", 6),
    entry("66666666", "競合F", 7),
  ];
  const rankings = [
    { areaKey: "akebonobashi_yotsuya3", genreKey: "bistro", area: "曙橋・四ツ谷三丁目", genre: "ビストロ", url: "https://tabelog.com/tokyo/A1309/A130903/rstLst/bistro/?Srt=D&SrtT=rt", selfRank: 3, totalOrganic: 7, entries: homeEntries },
    { areaKey: "akebonobashi_yotsuya3", genreKey: "french", area: "曙橋・四ツ谷三丁目", genre: "フレンチ", url: "https://tabelog.com/tokyo/A1309/A130903/rstLst/french/?Srt=D&SrtT=rt", selfRank: null, totalOrganic: 2, entries: [entry("11111111", "競合A", 1), entry("22222222", "競合B", 2)] },
  ];
  const opens = [
    { areaKey: "akebonobashi_yotsuya3", genreKey: "bistro", area: "曙橋・四ツ谷三丁目", genre: "ビストロ", url: "https://tabelog.com/tokyo/A1309/A130903/rstLst/bistro/?Srt=D&SrtT=nod", entries: [{ storeId: "77777777", name: "新店X", openedOn: "2026-10-01" }] },
  ];
  const self = { rating: 3.26, reviews: 49, saveCount: 4007, budgetNight: "¥8,000–¥9,999", budgetDay: "¥2,000–¥2,999", station: "曙橋駅 225m", openedOn: "2019-04-01" };
  return { self, rankings, opens };
}

test("isBlockedPublicPage: 403 / challenge HTML を検出し、通常の一覧は通す", () => {
  assert.equal(isBlockedPublicPage({ status: 403, html: "<html><title>OK</title></html>" }), "HTTP 403");
  assert.equal(isBlockedPublicPage({ status: 429, html: "" }), "HTTP 429");
  assert.match(isBlockedPublicPage({ status: 200, title: "Just a moment...", html: "<html>cf-browser-verification</html>" }), /制限/);
  assert.equal(isBlockedPublicPage({ status: 200, title: "曙橋・四ツ谷三丁目のビストロ ランキング | 食べログ", html: "<!DOCTYPE html><title>曙橋・四ツ谷三丁目のビストロ ランキング</title><div class='list-rst' data-rst-id='1'>" }), null);
});

test("pageTitle / ignored genre list", () => {
  assert.equal(pageTitle("<html><title>  曙橋・四ツ谷三丁目のビストロ ランキング | 食べログ\n</title></html>"), "曙橋・四ツ谷三丁目のビストロ ランキング | 食べログ");
  assert.equal(isIgnoredGenreList("おすすめのグルメ情報 | 食べログ"), true);
  assert.equal(isIgnoredGenreList("曙橋・四ツ谷三丁目のワインバー ランキング | 食べログ"), false);
});

test("assertTabelogUrl rejects other hosts; defaultOutDir uses JST day compact", () => {
  assert.equal(assertTabelogUrl("https://tabelog.com/tokyo/A1309/A130903/13245351/"), "https://tabelog.com/tokyo/A1309/A130903/13245351/");
  assert.throws(() => assertTabelogUrl("https://example.com/tokyo/13245351/"), /tabelog.com 以外/);
  assert.equal(defaultOutDir("2026-11-11"), "/workspace/run-20261111-tabelog-public");
});

test("public-only payload has no admin daily/monthly, includes reports, and ingest accepts it", () => {
  const { self, rankings, opens } = sampleParsed();
  const { result, payload } = buildPublicOnlyPayload({
    self, rankings, opens, storeKey: "13245351", competitorCap: 5,
    name: "BISTRO CAVA CAVA", publicUrl: "https://tabelog.com/tokyo/A1309/A130903/13245351/",
    runId: "tabelog-13245351-public-20261111", agent: "grok-bot",
    capturedAt: "2026-11-11T01:00:00.000Z", today: "2026-11-11",
  });
  assert.equal(result.status, "partial");
  assert.equal(result.warning, PUBLIC_ONLY_WARNING);
  assert.deepEqual(result.daily, []);
  assert.deepEqual(result.monthly, []);
  assert.equal(result.data.rating, 3.26);
  validateTabelogResult(result);
  const kinds = payload.stores[0].reports.map((r) => r.kind);
  assert.ok(kinds.includes("public_profile"));
  assert.ok(kinds.includes("public_genre_ranking"));
  assert.ok(kinds.includes("public_competitors"));
  assert.ok(kinds.includes("public_new_opens"));
  assert.equal(kinds.filter((k) => k === "public_genre_ranking").length, 2);
  const comps = payload.stores[0].reports.find((r) => r.kind === "public_competitors").data.entries;
  assert.deepEqual(comps.filter((c) => !c.own).map((c) => c.name), ["競合A", "競合B", "競合C", "競合D", "競合E"]);
  assert.equal(comps.at(-1).own, true);
  assert.equal(comps.at(-1).name, "BISTRO CAVA CAVA");
  assert.equal(comps.length, 6);
  const n = normalizeSourceIngest(payload, "2026-11-11");
  assert.equal(n.stores[0].days.length, 0);
  assert.equal(n.stores[0].months.length, 0);
  assert.ok(n.stores[0].reports.some((r) => r.kind === "public_competitors"));
  assert.equal(n.run.status, "partial");
});

test("validateTabelogResult accepts reports-only when rating is missing", () => {
  const { rankings, opens } = sampleParsed();
  const { result } = buildPublicOnlyPayload({
    self: { rating: null, reviews: null }, rankings, opens, storeKey: "13245351",
    runId: "tabelog-13245351-public-20261111", capturedAt: "2026-11-11T01:00:00.000Z", today: "2026-11-11",
  });
  validateTabelogResult(result);
  assert.throws(() => validateTabelogResult({ status: "partial", warning: "x", data: {}, daily: [], monthly: [], reviews: [] }), /保存できる数値/);
});

test("CAVA publicFetchPlan is 1 store + 18 list pages", () => {
  const plan = publicFetchPlan("13245351");
  assert.equal(plan.pages.length, 19);
  assert.equal(plan.pages[0].page, "tabelog_public_store");
  assert.equal(plan.pages.filter((p) => p.page === "tabelog_public_rank_genre").length, 9);
  assert.equal(plan.pages.filter((p) => p.page === "tabelog_public_rank_newopen").length, 9);
  assert.ok(plan.pages.every((p) => p.url.startsWith("https://tabelog.com/")));
});

test("weekly-assemble uses public-only payload for competitor/rank/newopen gaps without needing its daily rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-only-assemble-"));
  const admin = {
    schemaVersion: 1, source: "tabelog", runId: "tabelog-13245351-20261110015000", agent: "grok-bot",
    capturedAt: "2026-11-10T01:50:00.000Z",
    stores: [{
      storeKey: "13245351", name: "BISTRO CAVA CAVA",
      daily: Array.from({ length: 20 }, (_, i) => ({ date: `2026-10-${String(i + 22).padStart(2, "0")}`, pv: 100 + i, pvPc: 20, pvSp: 30, pvApp: 50 + i })),
      monthly: [
        { month: "2026-09", pv: 1000, reservations: 10, calls: 2, pvPc: 200, pvSp: 300, pvApp: 500 },
        { month: "2026-10", pv: 1100, reservations: 12, calls: 3, pvPc: 200, pvSp: 300, pvApp: 600 },
      ],
      reviews: { total: 0, items: [] }, reports: [],
    }],
  };
  // 10月は31日まで。daily を 10-22〜11-10 にする
  admin.stores[0].daily = [];
  for (let i = 0; i < 20; i++) {
    const d = new Date(Date.UTC(2026, 9, 22 + i)); // Oct 22 .. Nov 10
    admin.stores[0].daily.push({ date: d.toISOString().slice(0, 10), pv: 110 + i * 3, pvPc: 20, pvSp: 30, pvApp: 60 + i * 3 });
  }
  const { payload } = buildPublicOnlyPayload({
    ...sampleParsed(), storeKey: "13245351", competitorCap: 5, name: "BISTRO CAVA CAVA",
    publicUrl: "https://tabelog.com/tokyo/A1309/A130903/13245351/",
    runId: "tabelog-13245351-public-20261111", agent: "grok-bot",
    capturedAt: "2026-11-11T01:00:00.000Z", today: "2026-11-11",
  });
  const adminFile = path.join(dir, "admin.json");
  const pubFile = path.join(dir, "public.json");
  fs.writeFileSync(adminFile, JSON.stringify(admin));
  fs.writeFileSync(pubFile, JSON.stringify(payload));
  const without = assembleTabelogSources({ storeKey: "13245351", storeName: "BISTRO CAVA CAVA", asOf: "2026-11-11", payloadFiles: [adminFile] });
  assert.ok(without.gaps.some((g) => /競合/.test(g)));
  assert.ok(without.gaps.some((g) => /ジャンル順位/.test(g)));
  assert.ok(without.gaps.some((g) => /ニューオープン/.test(g)));
  const withPub = assembleTabelogSources({ storeKey: "13245351", storeName: "BISTRO CAVA CAVA", asOf: "2026-11-11", payloadFiles: [adminFile, pubFile] });
  assert.ok(!withPub.gaps.some((g) => /競合|ジャンル順位|ニューオープン/.test(g)), withPub.gaps.join(" / "));
  assert.ok(withPub.input.competitors.some((c) => c.own));
  assert.ok(withPub.input.competitors.some((c) => c.name === "競合A"));
  assert.ok(withPub.input.genreRanks.length >= 1);
  assert.ok(withPub.input.newOpens.some((e) => e.name === "新店X"));
  assert.ok(withPub.input.dailyRows.length >= 14);
});
