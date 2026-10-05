// 週報 → M-talk の店舗Bot のルーム（agent-api /weekly/deliver → mtalk-external-post /store-post）と、
// 週報のビュー → Pages 上の HTML（「週報を開く」）・任意 PDF・カードの要約、Grok Bot 用 CLI（scripts/weekly-deliver.mjs）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as PDFLib from "pdf-lib";
import * as fontkit from "fontkit";
import {
  STORE_POST_PATH, WEEKLY_APP_URL, WEEKLY_PAGES_BASE, WeeklyDeliveryError, buildWeeklyStorePost, deliverWeeklyReport, looksLikePersonalInfo,
  validateWeeklyDeliverInput, weekMonday, weeklyDedupeKey, weeklyFileName, weeklyHtmlRepoPath, weeklyHtmlUrl, weeklyRoomIds,
} from "../../supabase/functions/_shared/weekly-delivery.js";
import { mtalkConfig, mtalkRequest } from "../../supabase/functions/_shared/mtalk-share.js";
import { loadReportFonts, renderReportPdf } from "../../supabase/functions/_shared/report-pdf.js";
import * as fontModule from "../../supabase/functions/_shared/fonts/noto-sans-jp.js";
import { assembleWeeklyReportInput, buildTabelogWeeklyView } from "../../scripts/tabelog/weekly-report.js";
import { assembleIkyuWeeklyInput, buildIkyuWeeklyView } from "../../scripts/ikyu/weekly-report.js";
import { renderWeeklyPdf, tableMarkdown, weeklyCardSection, weeklyReportMarkdown } from "../../scripts/shared/weekly-pdf.js";
import { buildViews, deliverPayload, runWeeklyDeliver } from "../../scripts/weekly-deliver.mjs";

const STORE = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const CAVA_BOT = { id: "0b8d5a64-2f0e-4f7c-9a51-6c1d3e2f4a10", username: "BISTRO CAVACAVA", storeKey: "bistrocavacava", rooms: [{ id: 5, name: "全体", isStoreRoom: false, members: 30 }, { id: 30, name: "BISTRO CAVA CAVA", isStoreRoom: true, members: 8 }] };
const OTHER_BOT = { id: "1c9e6b75-3f1a-4a8d-8b62-7d2e4f3a5b21", username: "MITAN", storeKey: "mitan", rooms: [{ id: 7, name: "MITAN", isStoreRoom: true, members: 5 }] };
const PDF_B64 = Buffer.from(`%PDF-1.7\n${"x".repeat(80)}\n%%EOF`).toString("base64");
const section = (source = "tabelog", over = {}) => ({ source, fields: [{ label: "直近7日のPV", value: "1,234 PV（前7日比 +5.2%）" }, { label: "評価", value: "3.28" }], items: ["9月のPVは**4,753**"], ...over });
const deliverBody = (over = {}) => ({ site: { source: "tabelog", storeKey: "13245351" }, asOf: "2026-10-05", sections: [section("tabelog"), section("ikyu")], pdf: { base64: PDF_B64 }, ...over });

// ---------- 入力の検証 ----------
test("weekly deliver input: store, asOf, per-site sections; HTML is never attachable; guest PII is refused", () => {
  const input = validateWeeklyDeliverInput(deliverBody());
  assert.deepEqual(input.site, { source: "tabelog", storeKey: "13245351" });
  assert.equal(input.storeId, null);
  assert.deepEqual(input.sections.map((s) => s.heading), ["食べログ", "一休"]);
  assert.deepEqual(input.sections[0].items, ["9月のPVは4,753"], "**太字** の記号はカードでは外す");
  assert.equal(input.dryRun, false);
  assert.equal(input.pdf.filename, null);
  assert.equal(validateWeeklyDeliverInput(deliverBody({ storeId: STORE.toUpperCase(), site: undefined })).storeId, STORE);
  assert.equal(validateWeeklyDeliverInput(deliverBody({ dryRun: true })).dryRun, true);
  assert.deepEqual(validateWeeklyDeliverInput(deliverBody({ roomIds: [30, 30] })).roomIds, [30]);
  assert.equal(validateWeeklyDeliverInput(deliverBody({ pdf: undefined })).pdf, null, "PDFは任意");
  const bad = (over, re) => assert.throws(() => validateWeeklyDeliverInput(deliverBody(over)), (e) => e instanceof WeeklyDeliveryError && re.test(e.message));
  bad({ site: { source: "nope", storeKey: "1" } }, /storeId または site/);
  bad({ storeId: "x" }, /storeId/);
  bad({ asOf: "2026/10/05" }, /asOf/);
  bad({ sections: [] }, /sections/);
  bad({ sections: [section("tabelog"), section("tabelog")] }, /重複/);
  bad({ sections: [section("tabelog", { fields: [] })] }, /項目がありません/);
  bad({ sections: [section("tabelog", { items: ["山田様 090-1234-5678"] })] }, /個人情報/);
  bad({ sections: [section("ikyu", { fields: [{ label: "連絡", value: "guest@example.com" }] })] }, /個人情報/);
  bad({ pdf: { base64: Buffer.from("<!doctype html><html>…</html>").toString("base64") } }, /HTMLは添付できません/);
  bad({ pdf: { base64: "%%%" } }, /PDFの形式/);
  bad({ roomIds: [0] }, /roomIds/);
  bad({ dryRun: "yes" }, /dryRun/);
  assert.equal(looksLikePersonalInfo("118 PV（09/27–10/03、前7日比 −68.8%）"), false);
  assert.equal(looksLikePersonalInfo("190,800 円"), false);
  assert.equal(looksLikePersonalInfo("０３−１２３４−５６７８"), true);
});

test("weekly dedupe key: one per store and week (Monday, Japan date), so re-running the Monday job never posts twice", () => {
  for (const d of ["2026-10-05", "2026-10-07", "2026-10-11"]) assert.equal(weekMonday(d), "2026-10-05", d);
  assert.equal(weekMonday("2026-10-04"), "2026-09-28");
  assert.equal(weeklyDedupeKey(STORE.toUpperCase(), "2026-10-08"), `gourmet-weekly:${STORE}:2026-10-05`);
  assert.ok(weeklyDedupeKey(STORE, "2026-10-05").length + 3 <= 112, "M-talk の上限（PDF の :fN を含めて120）に収まる");
  assert.equal(weeklyFileName("BISTRO CAVA CAVA", "2026-10-05"), "BISTRO CAVA CAVA weekly 2026-10-05.pdf");
  assert.equal(weeklyFileName("焼肉マルゴ", "2026-10-05"), "weekly 2026-10-05.pdf");
});

test("store-post payload: the M-talk /store-post contract (not the /alert review schema)", () => {
  const input = validateWeeklyDeliverInput(deliverBody());
  const body = buildWeeklyStorePost({ storeId: STORE, storeName: "BISTRO CAVA CAVA", asOf: input.asOf, sections: input.sections, pdf: input.pdf, botId: CAVA_BOT.id, roomIds: [30], dryRun: false });
  assert.equal(STORE_POST_PATH, "/store-post");
  assert.deepEqual(Object.keys(body).sort(), ["bot_id", "dedupe_key", "files", "links", "note", "room_ids", "sections", "store_name", "subtitle", "title", "type"].sort());
  assert.equal(body.type, "weekly_report");
  assert.equal(body.title, "BISTRO CAVA CAVA 週報（食べログ・一休）");
  assert.equal(body.subtitle, "2026/10/05 作成（日本時間）");
  assert.equal(body.dedupe_key, `gourmet-weekly:${STORE}:2026-10-05`);
  assert.equal(WEEKLY_PAGES_BASE, "https://marugo-s.github.io/gourmet/weekly");
  assert.equal(weeklyHtmlUrl(STORE, "2026-10-05"), `${WEEKLY_PAGES_BASE}/${STORE}/2026-10-05/`);
  assert.equal(weeklyHtmlRepoPath(STORE, "2026-10-05"), `weekly/${STORE}/2026-10-05`);
  assert.deepEqual(body.links, [{ label: "週報を開く", url: weeklyHtmlUrl(STORE, "2026-10-05") }]);
  assert.deepEqual(body.files, [{ pdf_base64: PDF_B64, filename: "BISTRO CAVA CAVA weekly 2026-10-05.pdf" }]);
  assert.notEqual(body.links[0].url, WEEKLY_APP_URL, "アプリのトップではなく週報 HTML（Pages）を開く");
  assert.deepEqual(body.sections[0], { heading: "食べログ", fields: input.sections[0].fields, items: input.sections[0].items });
  for (const k of ["reviews", "score_changes", "recipient_user_id"]) assert.equal(k in body, false, k);
  const dry = buildWeeklyStorePost({ storeId: STORE, storeName: "BISTRO CAVA CAVA", asOf: input.asOf, sections: input.sections, pdf: null, botId: CAVA_BOT.id, roomIds: null, dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.equal("files" in dry || "room_ids" in dry, false);
});

// ---------- 送信の手順 ----------
function deps({ settings = null, bots = [CAVA_BOT, OTHER_BOT], store = { id: STORE, name: "BISTRO CAVA CAVA" }, reply } = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      findStore: async () => store,
      loadSettings: async () => settings,
      listBots: async () => bots,
      send: async (payload) => { sent.push(payload); return reply ? reply(payload) : { ok: true, bot_id: payload.bot_id, bot_name: "BISTRO CAVACAVA bot", rooms: [{ group_id: 30, name: "BISTRO CAVA CAVA", card_message_id: 900, file_message_ids: [901], deduplicated: false }], deduplicated: false }; },
    },
  };
}

test("deliver: auto-matches the BISTRO CAVA CAVA store bot and prefers its store room", async () => {
  const { sent, deps: d } = deps();
  const out = await deliverWeeklyReport(validateWeeklyDeliverInput(deliverBody()), d);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bot_id, CAVA_BOT.id);
  assert.deepEqual(sent[0].room_ids, [30], "店舗ルーム（is_store_room）だけ。全体ルームには送らない");
  assert.equal(out.ok, true);
  assert.deepEqual(out.bot, { id: CAVA_BOT.id, name: "BISTRO CAVACAVA bot", how: "exact" });
  assert.deepEqual(out.rooms, [{ id: 30, name: "BISTRO CAVA CAVA", isStoreRoom: undefined, cardMessageId: 900, fileMessageIds: [901], deduplicated: false }]);
  assert.equal(out.dedupeKey, `gourmet-weekly:${STORE}:2026-10-05`);
  assert.equal(out.pdf.filename, "BISTRO CAVA CAVA weekly 2026-10-05.pdf");
  assert.deepEqual(out.html, { url: weeklyHtmlUrl(STORE, "2026-10-05") });
});

test("deliver: rooms from the request, then the alert settings, then the store room, else all bot rooms", () => {
  const bot = { id: CAVA_BOT.id };
  assert.deepEqual(weeklyRoomIds({ requested: [5], settings: { roomIds: [30] }, bot, bots: [CAVA_BOT] }), [5]);
  assert.deepEqual(weeklyRoomIds({ requested: null, settings: { roomIds: [5] }, bot, bots: [CAVA_BOT] }), [5]);
  assert.deepEqual(weeklyRoomIds({ requested: null, settings: { roomIds: null }, bot, bots: [CAVA_BOT] }), [30]);
  assert.equal(weeklyRoomIds({ requested: null, settings: { roomIds: null }, bot, bots: [{ ...CAVA_BOT, rooms: [{ id: 5, isStoreRoom: false }] }] }), null);
});

test("deliver: dry run reaches M-talk with dry_run and posts nothing; 'none' and unmatched stores are skipped without calling M-talk", async () => {
  const dry = deps({ reply: (p) => ({ ok: true, dry_run: true, bot_name: "BISTRO CAVACAVA bot", rooms: [{ group_id: 30, name: "BISTRO CAVA CAVA", is_store_room: true, already_sent: false }], text: "[週報] BISTRO CAVA CAVA 週報（食べログ・一休）", cards: [], files: [] }) });
  const out = await deliverWeeklyReport(validateWeeklyDeliverInput(deliverBody({ dryRun: true })), dry.deps);
  assert.equal(dry.sent[0].dry_run, true);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.rooms, [{ id: 30, name: "BISTRO CAVA CAVA", isStoreRoom: true, alreadySent: false }]);
  assert.match(out.preview, /^\[週報\]/);

  const none = deps({ settings: { store_id: STORE, mtalk_bot_mode: "none" } });
  const skipped = await deliverWeeklyReport(validateWeeklyDeliverInput(deliverBody()), none.deps);
  assert.equal(skipped.ok, false);
  assert.match(skipped.skipped, /送らない/);
  assert.equal(none.sent.length, 0);

  const unmatched = deps({ store: { id: STORE, name: "三三五五" } });
  const r = await deliverWeeklyReport(validateWeeklyDeliverInput(deliverBody()), unmatched.deps);
  assert.match(r.skipped, /店舗Botが未設定/);
  assert.equal(unmatched.sent.length, 0);

  const manual = deps({ settings: { store_id: STORE, mtalk_bot_mode: "manual", mtalk_bot_id: OTHER_BOT.id, mtalk_room_ids: [7] } });
  await deliverWeeklyReport(validateWeeklyDeliverInput(deliverBody()), manual.deps);
  assert.equal(manual.sent[0].bot_id, OTHER_BOT.id);
  assert.deepEqual(manual.sent[0].room_ids, [7]);

  await assert.rejects(deliverWeeklyReport(validateWeeklyDeliverInput(deliverBody()), { ...deps().deps, findStore: async () => null }), (e) => e.status === 404);
  await assert.rejects(deliverWeeklyReport(validateWeeklyDeliverInput(deliverBody()), { ...deps().deps, configured: false }), (e) => e.status === 503);
});

test("mtalkRequest /store-post errors: 404 bot/room (no retry), missing route is 502, 422 PII, 400 shape", async () => {
  const config = mtalkConfig((k) => ({ MTALK_API_URL: "https://example.supabase.co/functions/v1/mtalk-external-post", GOURMET_MTALK_TOKEN: "t".repeat(40) })[k]);
  const reply = (status, data) => async () => new Response(JSON.stringify(data), { status });
  await assert.rejects(mtalkRequest(config, "POST", "/store-post", {}, { fetchImpl: reply(404, { error: "店舗Botが見つからないか、削除されています" }) }), (e) => e.status === 404 && /店舗Bot/.test(e.message));
  await assert.rejects(mtalkRequest(config, "POST", "/store-post", {}, { fetchImpl: reply(404, { error: "not found" }) }), (e) => e.status === 502, "M-talk 側が未配置");
  await assert.rejects(mtalkRequest(config, "POST", "/store-post", {}, { fetchImpl: reply(422, { error: "x" }) }), (e) => e.status === 422);
  await assert.rejects(mtalkRequest(config, "POST", "/store-post", {}, { fetchImpl: reply(400, { error: "x" }) }), (e) => e.status === 400);
  await assert.rejects(mtalkRequest(config, "POST", "/store-post", {}, { fetchImpl: reply(409, { error: "x" }) }), (e) => e.status === 409);
});

test("agent-api /weekly/deliver: INGEST_TOKEN only; the M-talk token stays in the Edge secrets", () => {
  const src = fs.readFileSync(new URL("../../supabase/functions/agent-api/index.ts", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('if (path === "/weekly/deliver")'), src.indexOf('if (path === "/credentials/versions")'));
  assert.ok(route.length > 100);
  assert.ok(src.indexOf("await authorized(req)") < src.indexOf('if (path === "/weekly/deliver")'), "X-Ingest-Token の確認の後");
  assert.match(route, /validateWeeklyDeliverInput\(input\)/);
  assert.match(route, /mtalkRequest\(mtalk, "POST", STORE_POST_PATH, payload/);
  assert.match(route, /\.eq\("user_id", userId\)/);
  assert.doesNotMatch(route, /GOURMET_MTALK_TOKEN|Deno\.env\.get\("MTALK/);
  assert.doesNotMatch(route, /ALERT_PATH/, "口コミ通知の /alert は使わない");
});

// ---------- ビュー → PDF・カード ----------
const days = (from, n, pv = (i) => 100 + (i % 7) * 10) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), pv: pv(i) };
});
const tabelogRaw = {
  storeKey: "13245351", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05",
  monthlyRows: [{ month: "2026-08", pv: 4624, reservations: 15, calls: 11 }, { month: "2026-09", pv: 4753, reservations: 14, calls: 5 }],
  dailyRows: days("2026-09-05", 30), reviews: [], publicProfile: { rating: 3.26, reviewCount: 49, saveCount: 4007 },
  competitors: [{ name: "ラトラスフィス", rating: 3.61, reviews: 146 }, { name: "BISTRO CAVA CAVA", rating: 3.26, reviews: 49, own: true }],
};
const ikyuPayload = {
  schemaVersion: 1, source: "ikyu", runId: "t", capturedAt: "2026-10-05T02:00:00Z",
  stores: [{ storeId: "112789", pageviews: { months: [{ month: "2026-09", totals: { pv: 719, reservations: 8, amount: 190800 }, days: days("2026-09-01", 30, (i) => 20 + (i % 5)) }] },
    reviews: { total: 1, items: [{ reservationNo: "R0001", postedAt: "2026-10-01", visitDate: "2026-09-30", handleName: "グルメ太郎", text: "とても美味しかった本文", rating: 4.5, scores: [], title: "", reply: null, processing: null, needsReply: true }] } }],
};
const views = () => [
  buildTabelogWeeklyView(assembleWeeklyReportInput(tabelogRaw)),
  buildIkyuWeeklyView(assembleIkyuWeeklyInput({ storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05", payloads: [ikyuPayload] })),
];

test("weekly markdown: every section of the shared template, tables keep their sources, no guest PII", () => {
  const md = weeklyReportMarkdown(views(), { storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05" });
  assert.match(md, /^# BISTRO CAVA CAVA 週報（食べログ・一休）/);
  for (const h of ["## 食べログ週報", "## 一休週報", "### まず、押さえたい4つの数字", "### 直近7日の閲覧数", "### 直近30日の日別PV", "### 自店の評価と新着口コミ", "### 次に取り組む3つのこと", "### 数字の見方"]) assert.ok(md.includes(h), h);
  assert.match(md, /ラトラスフィス \| 3\.61 \| 146/);
  assert.doesNotMatch(md, /グルメ太郎|R0001|美味しかった本文/, "ハンドルネーム・予約番号・口コミ本文は載せない");
  assert.deepEqual(tableMarkdown({ caption: "表X", head: [{ label: "a" }, { label: "b", num: true }], rows: [{ cells: ["x|y", { text: "1", num: true }] }] }), ["| a | b |", "| --- | ---: |", "| x｜y | 1 |", "", "_表X_", ""]);
});

test("weekly PDF: one A4 PDF for all sites (report-pdf.js), small enough for M-talk; card sections pass the deliver validation", async () => {
  const v = views();
  const pdf = await renderWeeklyPdf({ PDFLib, fontkit, fonts: await loadReportFonts(fontModule), renderReportPdf, views: v, storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05" });
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-");
  assert.ok(pdf.length < 1_000_000, `${pdf.length} bytes`);
  const doc = await PDFLib.PDFDocument.load(pdf);
  assert.ok(doc.getPageCount() >= 2);
  assert.equal(doc.getTitle(), "BISTRO CAVA CAVA 週報（食べログ・一休）");
  const sections = v.map(weeklyCardSection);
  assert.deepEqual(sections.map((s) => s.source), ["tabelog", "ikyu"]);
  assert.ok(sections.every((s) => s.fields.length === 5 && s.fields.at(-1).label === "直近7日のPV"));
  const input = validateWeeklyDeliverInput({ site: { source: "tabelog", storeKey: "13245351" }, asOf: "2026-10-05", sections });
  assert.equal(input.sections.length, 2);
});

test("weekly-deliver CLI: dry run by default, --send to post, --no-post stays local; the agent only sends X-Ingest-Token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-deliver-"));
  const tabelogInput = path.join(dir, "tabelog.json"), ikyuInput = path.join(dir, "ikyu.json");
  fs.writeFileSync(tabelogInput, JSON.stringify(tabelogRaw));
  fs.writeFileSync(ikyuInput, JSON.stringify(ikyuPayload));
  const argv = ["--tabelog-input", tabelogInput, "--ikyu-payload", ikyuInput, "--ikyu-store", "112789", "--name", "BISTRO CAVA CAVA", "--as-of", "2026-10-05"];
  assert.deepEqual(buildViews(Object.fromEntries([["tabelog-input", tabelogInput]])).map((x) => x.site.key), ["tabelog"]);
  assert.throws(() => buildViews({}), /tabelog-input/);

  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, dryRun: JSON.parse(init.body).dryRun, store: { name: "BISTRO CAVA CAVA" }, bot: { name: "BISTRO CAVACAVA bot" }, rooms: [] }), { status: 200 }); };
  const env = { INGEST_TOKEN: "i".repeat(40) };
  const out = await runWeeklyDeliver([...argv, "--out-dir", dir], { fetcher, env, log: () => {} });
  assert.equal(out.dryRun, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/agent-api\/weekly\/deliver$/);
  assert.equal(calls[0].init.headers["X-Ingest-Token"], env.INGEST_TOKEN);
  assert.equal(JSON.stringify(calls[0].init).includes("GOURMET_MTALK_TOKEN"), false);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.dryRun, true);
  assert.deepEqual(sent.site, { source: "tabelog", storeKey: "13245351" });
  assert.equal(sent.pdf, undefined, "既定では PDF を M-talk に載せない（HTML が本体）");
  assert.ok(fs.existsSync(path.join(dir, "BISTRO CAVA CAVA weekly 2026-10-05.pdf")), "out-dir では手元確認用に PDF も書く");
  assert.ok(fs.existsSync(path.join(dir, "tabelog-weekly-2026-10-05.html")) && fs.existsSync(path.join(dir, "ikyu-weekly-2026-10-05.html")), "HTML は手元の確認用");
  assert.ok(fs.existsSync(path.join(dir, "html", "index.html")) && fs.existsSync(path.join(dir, "html", "tabelog.html")), "ハブ＋サイト別 HTML");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "weekly-card-2026-10-05.json"), "utf8")).pdf, undefined, "カードの JSON に PDF の中身を書かない");

  const pub = path.join(dir, "public");
  await runWeeklyDeliver([...argv, "--no-post", "--store-id", STORE, "--publish-dir", pub, "--allow-unassembled"], { fetcher, env: {}, log: () => {} });
  const published = path.join(pub, "weekly", STORE, "2026-10-05");
  assert.ok(fs.existsSync(path.join(published, "index.html")));
  assert.ok(fs.existsSync(path.join(published, "tabelog.html")) && fs.existsSync(path.join(published, "ikyu.html")));
  assert.match(fs.readFileSync(path.join(published, "index.html"), "utf8"), /週報を開く|食べログ週報|一休週報/);

  await runWeeklyDeliver([...argv, "--send", "--store-id", STORE, "--room", "30", "--allow-unassembled"], { fetcher, env, log: () => {} });
  const live = JSON.parse(calls[1].init.body);
  assert.equal(live.dryRun, false);
  assert.equal(live.storeId, STORE);
  assert.deepEqual(live.roomIds, [30]);
  assert.equal(live.pdf, undefined, "--pdf 無しでは添付なし");

  await runWeeklyDeliver([...argv, "--send", "--pdf", "--store-id", STORE, "--room", "30", "--allow-unassembled"], { fetcher, env, log: () => {} });
  const withPdf = JSON.parse(calls[2].init.body);
  assert.equal(Buffer.from(withPdf.pdf.base64, "base64").subarray(0, 5).toString(), "%PDF-");

  const local = await runWeeklyDeliver([...argv, "--no-post"], { fetcher, env: {}, log: () => {} });
  assert.equal(calls.length, 3, "--no-post は agent-api を呼ばない（トークンも不要）");
  assert.equal(local.posted, false);
  assert.throws(() => deliverPayload({ views: views(), pdf: null, args: { "store-id": "bad" } }), /storeId/);
});
