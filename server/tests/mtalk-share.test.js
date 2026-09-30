import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as PDFLib from "pdf-lib";
import * as fontkit from "fontkit";
import {
  MTALK_SHARE_LIMITS, MtalkError, buildShareCard, bytesToBase64, mtalkConfig, mtalkRequest, normalizeRecipients, publicShare, senderLabel, shareFileName,
  signMtalkRequest, validateShareInput,
} from "../../supabase/functions/_shared/mtalk-share.js";
import { inlineRuns, loadReportFonts, parseReportMarkdown, renderReportPdf } from "../../supabase/functions/_shared/report-pdf.js";
import * as fontModule from "../../supabase/functions/_shared/fonts/noto-sans-jp.js";
import { sampleReport } from "./fixtures/mtalk-sample-report.js";

const TOKEN = "t".repeat(40);
const URL_OK = "https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/mtalk-external-post";
const env = (vals) => (k) => vals[k];

test("signature matches the line_report mtalk-external-post contract (shared test vector)", async () => {
  // line_report tests/mtalk_external_post.test.ts が同じ値を検証する
  assert.equal(await signMtalkRequest(TOKEN, { timestamp: "1790000000", method: "POST", path: "/send", body: '{"x":1}' }),
    "v1=3c1f2de63d53099311e5d2618d4349120bad3133005317b5810d823f885e8ca4");
});

test("config requires an https mtalk-external-post URL and a long token", () => {
  assert.equal(mtalkConfig(env({ MTALK_API_URL: URL_OK, GOURMET_MTALK_TOKEN: TOKEN })).configured, true);
  assert.equal(mtalkConfig(env({ MTALK_API_URL: `${URL_OK}/`, GOURMET_MTALK_TOKEN: TOKEN })).configured, true);
  assert.equal(mtalkConfig(env({ MTALK_API_URL: URL_OK.replace("https", "http"), GOURMET_MTALK_TOKEN: TOKEN })).configured, false);
  assert.equal(mtalkConfig(env({ MTALK_API_URL: "https://example.com/other", GOURMET_MTALK_TOKEN: TOKEN })).configured, false);
  assert.equal(mtalkConfig(env({ MTALK_API_URL: URL_OK, GOURMET_MTALK_TOKEN: "short" })).configured, false);
  assert.equal(mtalkConfig(env({})).configured, false);
});

test("requests are signed and errors never leak the URL, token, or response body", async () => {
  const config = mtalkConfig(env({ MTALK_API_URL: URL_OK, GOURMET_MTALK_TOKEN: TOKEN }));
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, file_message_id: 5 }), { status: 200 }); };
  const r = await mtalkRequest(config, "POST", "/send", { a: 1 }, { fetchImpl: ok, now: () => 1_790_000_000_000 });
  assert.equal(r.file_message_id, 5);
  assert.equal(seen.url, `${URL_OK}/send`);
  assert.equal(seen.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.init.headers["X-Mtalk-Timestamp"], "1790000000");
  assert.equal(seen.init.headers["X-Mtalk-Signature"], await signMtalkRequest(TOKEN, { timestamp: "1790000000", method: "POST", path: "/send", body: '{"a":1}' }));
  for (const [status, re] of [[401, /接続設定/], [404, /送信先/], [409, /処理中/], [413, /大きすぎる/], [500, /完了できません/]]) {
    const fail = async () => new Response(JSON.stringify({ error: `secret ${TOKEN} ${URL_OK}` }), { status });
    await assert.rejects(mtalkRequest(config, "POST", "/send", {}, { fetchImpl: fail }), (e) => {
      assert.ok(e instanceof MtalkError);
      assert.match(e.message, re);
      assert.doesNotMatch(e.message, /tttt|supabase\.co|secret/);
      return true;
    });
  }
  await assert.rejects(mtalkRequest(config, "GET", "/recipients", null, { fetchImpl: async () => { throw new Error(URL_OK); } }), (e) => !/supabase/.test(e.message));
  await assert.rejects(mtalkRequest(mtalkConfig(env({})), "GET", "/recipients", null), (e) => e.status === 503);
});

test("share input, recipients and public rows are normalized", () => {
  assert.deepEqual(validateShareInput({ recipient_user_id: "11111111-2222-4333-8444-555555555555".toUpperCase() }), { recipientUserId: "11111111-2222-4333-8444-555555555555" });
  assert.throws(() => validateShareInput({ recipient_user_id: "nope" }), /送信先/);
  assert.throws(() => validateShareInput(null), /送信先/);
  const list = normalizeRecipients({ recipients: [{ id: "11111111-2222-4333-8444-555555555555", username: " 佐藤 ", stores: ["BISTRO CAVACAVA", ""] }, { id: "x", username: "bad" }, { id: "22222222-2222-4333-8444-555555555555", username: "" }] });
  assert.deepEqual(list, [{ id: "11111111-2222-4333-8444-555555555555", username: "佐藤", stores: ["BISTRO CAVACAVA"] }]);
  const row = publicShare({ id: "s", report_id: "r", report_title: "t", recipient_user_id: "u", recipient_name: "佐藤", status: "sent", error: "x", created_at: "c", sent_at: "d", mtalk_group_id: 9 });
  assert.equal(row.error, null);
  assert.equal("mtalk_group_id" in row, false);
});

test("sender label comes from the verified account, never from the request", () => {
  assert.equal(senderLabel({ email: "yamada@example.com", user_metadata: { full_name: "山田 太郎" } }), "山田 太郎（yamada@example.com）");
  assert.equal(senderLabel({ email: "yamada@example.com", user_metadata: {} }), "yamada@example.com");
  assert.equal(senderLabel(null), "Review Command Center の利用者");
});

test("card carries title, store, period, sender and key numbers within M-talk limits", () => {
  const c = buildShareCard(sampleReport, { sender: "山田 太郎" });
  assert.equal(c.title, "BISTRO CAVACAVA 7〜9月 分析レポート");
  assert.equal(c.sender_label, "山田 太郎");
  const f = Object.fromEntries(c.card.fields.map((x) => [x.label, x.value]));
  assert.equal(f["店舗"], "BISTRO CAVACAVA");
  assert.equal(f["期間"], "2026-07-01〜2026-09-29（91日間）");
  assert.equal(f["PV"], "48,210（前期間比 +15.13%）");
  assert.equal(f["予約"], "312件");
  assert.equal(f["未返信"], "7件");
  assert.equal(f["作成"], "2026-09-30 10:23（日本時間）");
  assert.ok(c.card.fields.length <= 10);
  assert.equal(c.card.highlights.length, 3);
  assert.deepEqual(c.card.recommendations[0], "［高］週末夜のホール体制を1名増やす");
  for (const s of [...c.card.highlights, ...c.card.recommendations, ...c.card.fields.map((x) => x.value)]) assert.ok([...s].length <= 200);
  // 集計が無い古いレポートでも店舗・期間だけで作れる
  const bare = buildShareCard({ title: "t", storeName: "店", from: "2026-01-01", to: "2026-01-31", content: {} }, { sender: "s" });
  assert.deepEqual(bare.card.fields.map((x) => x.label), ["店舗", "期間"]);
  assert.deepEqual(bare.card.highlights, []);
});

test("pdf file name uses only characters M-talk keeps", () => {
  assert.equal(shareFileName(sampleReport), "BISTRO CAVACAVA AI-report 2026-07-01_2026-09-29.pdf");
  assert.match(shareFileName({ storeName: "全店舗", from: "2026-01-01", to: "2026-01-31" }), /^[A-Za-z0-9._() -]+$/);
  assert.equal(bytesToBase64(new Uint8Array([37, 80, 68, 70])), "JVBERg==");
});

test("markdown is parsed into report blocks (headings, lists, tables, notes)", () => {
  const blocks = parseReportMarkdown(sampleReport.markdown);
  assert.equal(blocks[0].type, "heading");
  assert.ok(blocks.some((b) => b.type === "table" && b.head[0] === "項目"));
  assert.ok(blocks.some((b) => b.type === "item" && b.marker === "1."));
  assert.equal(blocks[blocks.length - 1].note, true);
  assert.deepEqual(inlineRuns("A **太字** と [リンク](https://x.test) `c`"), [{ text: "A ", bold: false }, { text: "太字", bold: true }, { text: " と リンク c", bold: false }]);
});

test("pdf renders Japanese with embedded Noto Sans JP subsets", async () => {
  const fonts = await loadReportFonts(fontModule);
  const bytes = await renderReportPdf({ PDFLib, fontkit, fonts, report: sampleReport, meta: ["送信者: 山田 太郎", "絵文字🍷と外字𠮷は〓になる"] });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  assert.ok(bytes.byteLength < 400_000, `subset PDF should be small (${bytes.byteLength})`);
  assert.ok(bytes.byteLength < MTALK_SHARE_LIMITS.pdfMaxBytes);
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getTitle(), sampleReport.title);
  let text = null;
  try { text = execFileSync("pdftotext", ["-", "-"], { input: Buffer.from(bytes) }).toString(); } catch { /* pdftotext が無い環境では省略 */ }
  if (text != null) {
    for (const s of ["BISTRO CAVACAVA 7〜9月 分析レポート", "1. サマリー", "送信者: 山田 太郎", "週末夜のホール体制を1名増やす", "〓"]) assert.ok(text.includes(s), `missing ${s}`);
  }
});

test("migration and ai-analyst keep ownership, RLS, limits and secrets server-side", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/015_ai_report_shares.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.ai_report_shares/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(sql, /revoke all on public\.ai_report_shares from anon, authenticated;/);
  assert.match(sql, /grant select on public\.ai_report_shares to authenticated;/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)/i);
  const src = readFileSync(new URL("../../supabase/functions/ai-analyst/index.ts", import.meta.url), "utf8");
  const share = src.slice(src.indexOf("if (sharePath.test(path)"));
  assert.match(share, /\.eq\("id", reportId\)\.eq\("user_id", user\.id\)/);
  assert.match(share, /MTALK_SHARE_LIMITS\.perHour/);
  assert.match(share, /dedupe_key:`gourmet:\$\{share\.id\}`/);
  assert.ok(src.indexOf("auth.getUser(token)") < src.indexOf("mtalkConfig("), "JWT is verified before any M-talk access");
  assert.doesNotMatch(src, /json\(req, \{[^}]*(token|MTALK_API_URL|GOURMET_MTALK_TOKEN)/);
  const ui = readFileSync(new URL("../../src/components/MtalkShare.tsx", import.meta.url), "utf8") + readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /GOURMET_MTALK_TOKEN|MTALK_API_URL|mtalk-external-post/);
});
