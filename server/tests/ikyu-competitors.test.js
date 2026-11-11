// 一休の週報「競合比較」: 設定で選んだ近隣の比較店の公開ページ → スナップショット（ikyu-competitors.json）→ 週報の入力・表示。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPETITORS_KIND, buildCompetitorSnapshot, competitorConfig, competitorRows, competitorSnapshotProblem, parseCompetitorPage } from "../../scripts/ikyu/competitors.js";
import { assembleIkyuSources, discoverRunFiles } from "../../scripts/shared/weekly-sources.js";
import { buildIkyuWeeklyView } from "../../scripts/ikyu/weekly-report.js";
import { runIkyuPublicCompetitors } from "../../scripts/ikyu-public-competitors.mjs";

const page = ({ name, area = "四谷三丁目", genre = "ビストロ", rating = null, count = null, belowMin = false, price = "夜：6,000円〜7,999円　昼：3,000円〜3,999円", station = "四ツ谷駅 徒歩1分" }) => `<!doctype html><html><head><title>${name} - ${area}/${genre} [一休.comレストラン]</title></head><body>
<div itemProp="aggregateRating">${rating != null ? `<meta itemProp="ratingValue" content="${rating}"/><meta itemProp="reviewCount" content="${count}"/><span>${rating}</span><span>（</span><span>${count}</span><span>件）</span>` : ""}
${belowMin ? `<span>規定評価数に達していません</span><span>（</span><span>${count}</span><span>件）</span>` : ""}</div>
<meta itemProp="priceRange" content="${price}"/><div><span>${station}</span></div><div>この店舗の最寄りの駅からの行き方は？</div>
<div itemType="https://schema.org/Review"><a href="/reviews/user/abcdef0123/">ある投稿者</a><span itemProp="reviewBody">本文</span></div></body></html>`;

const CONFIG = { stores: { "112789": { areaLabel: "四谷三丁目・曙橋周辺", selection: "四谷周辺のワインバー・ビストロ・フレンチ・イタリアン（一休掲載店から選定）", competitors: [{ storeId: "113649", category: "ビストロ・ワインバー" }, { storeId: "148912", category: "ビストロ" }, { storeId: "112789", category: "自店は除く" }] } } };

test("competitor page: rating, review count, price range and station from the public page only; hidden ratings stay null", () => {
  const a = parseCompetitorPage("113649", page({ name: "アラブテイユ (a La Bouteille)", genre: "ビストロ・ワインバー", rating: 4.5, count: 5 }));
  assert.deepEqual([a.name, a.genre, a.rating, a.reviews, a.priceDinner, a.priceLunch, a.station, a.url], ["アラブテイユ (a La Bouteille)", "ビストロ・ワインバー", 4.5, 5, "6,000円〜7,999円", "3,000円〜3,999円", "四ツ谷駅 徒歩1分", "https://restaurant.ikyu.com/113649/"]);
  const b = parseCompetitorPage("148912", page({ name: "ワイン酒場 やかん", belowMin: true, count: 1, price: "夜：4,000円〜4,999円", station: "曙橋駅 A3出口から 徒歩2分" }));
  assert.equal(b.rating, null, "規定評価数未満は評価なし（作らない）");
  assert.equal(b.reviews, 1);
  assert.equal(b.priceLunch, null);
  assert.equal(b.station, "曙橋駅 A3出口から徒歩2分");
  assert.equal(JSON.stringify(b).includes("ある投稿者"), false, "口コミの投稿者・本文は読まない");
  assert.throws(() => parseCompetitorPage("113649", "<title>ログイン</title>"), /店舗ページではありません/);
  assert.throws(() => parseCompetitorPage("12", page({ name: "x" })), /6桁/);
});

test("competitor config: the repo's CAVA set is wine bar / bistro / French / Italian near Yotsuya and never includes the store itself", () => {
  const cfg = competitorConfig("112789");
  assert.ok(cfg.competitors.length >= 5 && cfg.competitors.length <= 8);
  assert.ok(cfg.competitors.every((c) => /ワインバー|ビストロ|フレンチ|イタリアン/.test(c.category)));
  assert.ok(!cfg.competitors.some((c) => c.storeId === "112789"));
  assert.match(cfg.selection, /一休掲載店から選定/);
  assert.equal(competitorConfig("999999"), null);
});

test("snapshot → weekly input: own row first, rated competitors by rating, unrated last; assembler uses the newest snapshot on/before asOf within 14 days", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ikyu-comp-"));
  const cfgFile = path.join(dir, "cfg.json");
  fs.writeFileSync(cfgFile, JSON.stringify(CONFIG));
  const config = competitorConfig("112789", { file: cfgFile });
  assert.equal(config.competitors.length, 2, "自店は比較店から外す");
  const pages = { "113649": page({ name: "アラブテイユ", rating: 4.5, count: 5 }), "148912": page({ name: "やかん", belowMin: true, count: 1 }) };
  const snap = buildCompetitorSnapshot({ storeId: "112789", config, pages, ownHtml: page({ name: "ビストロ サヴァサヴァ", rating: 4.38, count: 4 }), capturedAt: "2026-11-11T03:00:00Z", runId: "ikyu-public-20261111-112789" });
  assert.equal(snap.kind, COMPETITORS_KIND);
  assert.equal(competitorSnapshotProblem(snap, "112789"), null);
  assert.match(competitorSnapshotProblem({ ...snap, runId: "t" }, "112789"), /runId/);
  const rows = competitorRows({ ...snap, competitors: [...snap.competitors].reverse() }, { ownName: "BISTRO CAVA CAVA", ownProfile: { rating: 4.38, reviewCount: 4 } });
  assert.deepEqual(rows.map((r) => [r.own, r.name, r.rating]), [[true, "BISTRO CAVA CAVA", 4.38], [false, "アラブテイユ", 4.5], [false, "やかん", null]]);

  const run = (name, s) => { const d = path.join(dir, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "ikyu-competitors.json"), JSON.stringify(s)); return path.join(d, "ikyu-competitors.json"); };
  const fresh = run("run-20261111-ikyu-public", snap);
  const late = run("run-20261113-ikyu-public", { ...snap, capturedAt: "2026-11-13T03:00:00Z" });
  const old = run("run-20261020-ikyu-public", { ...snap, capturedAt: "2026-10-20T03:00:00Z" });
  const found = discoverRunFiles(dir).ikyuCompetitors.sort();
  assert.deepEqual(found, [fresh, late, old].sort());
  const payload = { schemaVersion: 1, source: "ikyu", agent: "grok-bot", runId: "ikyu-20261111030859", capturedAt: "2026-11-11T03:08:59Z", stores: [{ storeId: "112789", public: { rating: 4.38, reviewCount: 4, reviews: [] }, pageviews: { months: [] } }] };
  const pf = path.join(dir, "payload.json");
  fs.writeFileSync(pf, JSON.stringify(payload));
  const r = assembleIkyuSources({ storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-11-11", payloadFiles: [pf], competitorFiles: found });
  assert.deepEqual(r.input.competitors.map((c) => c.name), ["BISTRO CAVA CAVA", "アラブテイユ", "やかん"], "スナップショットの比較店＋自店（自店の評価は自店の公開ページ取り込み）");
  assert.equal(r.input.competitors[0].rating, 4.38);
  assert.equal(r.sources.find((s) => s.kind === "competitors").file, fresh);
  assert.ok(r.rejected.some((x) => x.file === late && /作成日より後/.test(x.reason)));
  assert.ok(r.rejected.some((x) => x.file === old && /古い/.test(x.reason)));
  assert.ok(!r.knownGaps.some((g) => g.startsWith("一休の競合比較")), "比較店があれば「未対応」から外す");
  assert.match(r.input.competitorsNote, /一休掲載店から選定/);
  const none = assembleIkyuSources({ storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-11-11", payloadFiles: [pf], competitorFiles: [old] });
  assert.ok(none.gaps.some((g) => /比較店/.test(g)), "設定があるのに新しい取得が無ければ足りない項目（取り直す）");
});

test("weekly view: selection reason in the lead and the table, numbered competitors, 未取得 for hidden ratings, price bullet", () => {
  const input = {
    storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-11-11", monthly: { prev: {}, cur: {} }, daily: [], publicProfile: { rating: 4.38, reviewCount: 4 },
    competitorsNote: "四谷周辺のワインバー・ビストロ・フレンチ・イタリアン（一休掲載店から選定）", competitorsCapturedOn: "2026-11-11", areaLabel: "四谷三丁目・曙橋周辺",
    competitors: [{ own: true, name: "BISTRO CAVA CAVA", rating: 4.38, reviews: 4, price: "夜：8,000円〜9,999円" }, { own: false, name: "A", rating: 4.5, reviews: 5, price: "夜：6,000円〜7,999円" }, { own: false, name: "B", rating: null, reviews: 1, price: null }],
  };
  const json = JSON.stringify(buildIkyuWeeklyView(input));
  assert.match(json, /競合比較（近隣の比較店）/);
  assert.match(json, /四谷周辺のワインバー・ビストロ・フレンチ・イタリアン（一休掲載店から選定）。評価と口コミ件数/);
  assert.match(json, /評価が出ていない比較店1店/);
  assert.match(json, /比較店の価格帯（公開ページの表示）は表5を参照/);
  assert.match(json, /2026\/11\/11 取得／評価は点、口コミは件／四谷周辺/);
});

test("CLI: fetches only restaurant.ikyu.com/<id>/ pages politely, saves them, and stops on 403 / challenge without retrying", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ikyu-comp-cli-"));
  const cfgFile = path.join(dir, "cfg.json");
  fs.writeFileSync(cfgFile, JSON.stringify(CONFIG));
  const calls = [], waits = [];
  const html = { "112789": page({ name: "ビストロ サヴァサヴァ", rating: 4.38, count: 4 }), "113649": page({ name: "アラブテイユ", rating: 4.5, count: 5 }), "148912": page({ name: "やかん", belowMin: true, count: 1 }) };
  const fetcher = async (url, init) => { calls.push({ url, init }); const id = url.match(/(\d{6})/)[1]; return new Response(html[id], { status: 200 }); };
  const out = await runIkyuPublicCompetitors(["--store", "112789", "--out-dir", dir, "--delay-ms", "100"], { fetcher, configFile: cfgFile, log: () => {}, wait: async (ms) => waits.push(ms), now: new Date("2026-11-11T03:00:00Z") });
  assert.deepEqual(calls.map((c) => c.url), ["https://restaurant.ikyu.com/112789/", "https://restaurant.ikyu.com/113649/", "https://restaurant.ikyu.com/148912/"]);
  assert.ok(waits.length === 2 && waits.every((ms) => ms >= 2500), "間隔は 2.5 秒以上（短くできない）");
  assert.equal(calls[0].init.redirect, "manual");
  assert.match(calls[0].init.headers["User-Agent"], /Chrome/);
  assert.ok(fs.existsSync(path.join(dir, "store-113649.html")));
  assert.equal(out.snapshot.competitors.length, 2);
  assert.equal(out.snapshot.runId, "ikyu-public-20261111-112789");

  const blocked = async () => new Response("<title>Just a moment...</title>", { status: 403 });
  await assert.rejects(runIkyuPublicCompetitors(["--store", "112789", "--out-dir", dir], { fetcher: blocked, configFile: cfgFile, log: () => {}, wait: async () => {} }), /回避せず停止/);
  const challenge = async () => new Response("<title>x</title><div class=challenge-platform>captcha</div>", { status: 200 });
  await assert.rejects(runIkyuPublicCompetitors(["--store", "112789", "--out-dir", dir], { fetcher: challenge, configFile: cfgFile, log: () => {}, wait: async () => {} }), /回避せず停止/);
  const redirect = async () => new Response("", { status: 301, headers: { location: "/login" } });
  await assert.rejects(runIkyuPublicCompetitors(["--store", "112789", "--out-dir", dir], { fetcher: redirect, configFile: cfgFile, log: () => {}, wait: async () => {} }), /リダイレクト/);

  // 保存済み HTML だけ（ネットワークなし）
  let net = 0;
  const offline = await runIkyuPublicCompetitors(["--store", "112789", "--from-dir", dir], { fetcher: async () => { net++; }, configFile: cfgFile, log: () => {} });
  assert.equal(net, 0);
  assert.equal(offline.snapshot.competitors.length, 2);
});
