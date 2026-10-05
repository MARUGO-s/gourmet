// AI分析の質問への回答をPDFでダウンロードする（ai-analyst POST /answer-pdf）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as PDFLib from "pdf-lib";
import * as fontkit from "fontkit";
import { ANSWER_PDF_LIMITS, answerPdfDocument, validateAnswerPdfInput } from "../../supabase/functions/_shared/ai-analyst.js";
import { loadReportFonts, parseReportMarkdown, renderReportPdf } from "../../supabase/functions/_shared/report-pdf.js";
import * as fontModule from "../../supabase/functions/_shared/fonts/noto-sans-jp.js";

const answer = "### 結論\n**PVは食べログが多い**\n\n| 指標 | 食べログ | 一休.comレストラン |\n| --- | --- | --- |\n| PV | 14,235 | 1,622 |\n\n> データ：一休 10/5 11:14取得";
const input = { question: "食べログと一休で、PV・予約・評価を比較して", answer, storeName: "全店舗", from: "2026-07-07", to: "2026-10-04",
  askedAt: "2026-10-05T14:47:00Z", answeredAt: "2026-10-05T14:47:40Z", model: "gpt-6-luna" };

test("入力: 回答は必須・長さの上限。日付・日時が不正なら使わない。制御文字は落とす", () => {
  const v = validateAnswerPdfInput({ ...input, answer: `${answer}\u0007` });
  assert.equal(v.answer, answer);
  assert.equal(v.askedAt, "2026-10-05T14:47:00.000Z");
  assert.throws(() => validateAnswerPdfInput({ ...input, answer: "  " }), /回答がありません/);
  assert.throws(() => validateAnswerPdfInput({ ...input, answer: "あ".repeat(ANSWER_PDF_LIMITS.answer + 1) }), /長すぎる/);
  assert.throws(() => validateAnswerPdfInput(null), /入力形式/);
  const loose = validateAnswerPdfInput({ answer: "x", from: "2026/07/07", to: "nope", askedAt: "nope" });
  assert.deepEqual([loose.from, loose.to, loose.askedAt, loose.question], [null, null, null, ""]);
});

test("中身: 見出し（AI分析の回答）・対象と日時（日本時間）・質問・回答の順。質問が無ければ回答だけ", () => {
  const { report, meta } = answerPdfDocument(validateAnswerPdfInput(input), "2026-10-05T15:00:00Z");
  assert.equal(report.title, "AI分析の回答");
  assert.deepEqual(meta, ["対象: 全店舗 · 2026-07-07 〜 2026-10-04", "質問: 2026-10-05 23:47（日本時間）", "回答: 2026-10-05 23:47（日本時間） · gpt-6-luna", "PDF出力: 2026-10-06 00:00（日本時間）"]);
  const blocks = parseReportMarkdown(report.markdown);
  assert.deepEqual(blocks.filter((b) => b.type === "heading").map((b) => [b.level, b.text]), [[1, "AI分析の回答"], [2, "質問"], [2, "回答"], [3, "結論"]]);
  assert.ok(blocks.some((b) => b.type === "table" && b.rows[0][1] === "14,235"));
  assert.ok(blocks.some((b) => b.type === "quote" && b.text.startsWith("データ：")));
  const noQ = answerPdfDocument(validateAnswerPdfInput({ answer: "回答だけ" }), "2026-10-05T15:00:00Z");
  assert.doesNotMatch(noQ.report.markdown, /## 質問/);
  assert.deepEqual(noQ.meta, ["PDF出力: 2026-10-06 00:00（日本時間）"]);
});

test("PDF: 日本語フォントを埋め込んだ1ページのPDFになる", async () => {
  const { report, meta } = answerPdfDocument(validateAnswerPdfInput(input), "2026-10-05T15:00:00Z");
  const bytes = await renderReportPdf({ PDFLib, fontkit, fonts: await loadReportFonts(fontModule), report, meta, footer: "Review Command Center" });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), "AI分析の回答");
});

test("配線: ai-analyst の /answer-pdf はログイン後（JWT検証の後）で、画面の回答に「PDFをダウンロード」がある", () => {
  const ai = fs.readFileSync(new URL("../../supabase/functions/ai-analyst/index.ts", import.meta.url), "utf8");
  assert.match(ai, /if \(path === "\/answer-pdf" && req\.method === "POST"\)/);
  assert.ok(ai.indexOf("admin.auth.getUser(token)") < ai.indexOf('path === "/answer-pdf"'), "ログインの確認の後");
  assert.match(ai, /"Content-Type":"application\/pdf"/);
  const page = fs.readFileSync(new URL("../../src/components/AiAnalystPage.tsx", import.meta.url), "utf8");
  assert.match(page, /PDFをダウンロード/);
  assert.match(page, /downloadAnswerPdf\(/);
});
