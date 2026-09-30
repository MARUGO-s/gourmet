// AI分析の正確さの回帰テスト。2026-10-01 に M-talk（トーク44）で誤答した3つの質問を、本番データと同じ形のデータで再現する。
//   03:10「最新の口コミ」 → 投稿日の無い食べログ（来店2026-09）を見落とした
//   03:40「悪い口コミ」   → 期間内の口コミ全件数（3）を「評価3以下が3件（本文なし）」と誤答
//   03:42「食べログですか」→ 前の回答（3件）を訂正したが、全期間の食べログの低評価（3件）は答えられなかった
import test from "node:test";
import assert from "node:assert/strict";
import { RATING_BANDS, isLowRating, reviewStats, runTool, systemPrompt, normalizeReportAi } from "../../supabase/functions/_shared/ai-analyst.js";
import {
  SAFE_NO_DATA_ANSWER, SANITIZED_NOTE, buildEvidence, ensureScopeMention, extractClaims, hasClaims, labelReportSpeculation, labelSpeculation,
  sanitizeAnswer, sanitizeReportAi, stripCitations, verifyAnswer, verifyReportAi,
} from "../../supabase/functions/_shared/answer-verify.js";
import { ANSWER_GUARD, answerWithTools } from "../../supabase/functions/_shared/openai.js";
import { mtalkChatPrompt, reportContextMessage, reportFactLines } from "../../supabase/functions/_shared/mtalk-chat.js";

const rv = (id, source, rating, date, text = "本文あり", extra = {}) => ({ id, source, rating, date, text, title: "", details: {}, ...extra });
// 本番（オーナー 114c…）の口コミの形: 食べログは投稿日の無いオーナー画面の抜粋（本文なし・来店月だけ）を含む
const ds = {
  today: "2026-10-01", stores: [], sites: [], daily: [], legacy: [], monthly: [], current: [],
  reviews: [
    rv("t1", "tabelog", 4.2, "2026-06-10", "美味しかった"),
    rv("t2", "tabelog", 3.8, "2025-12-01"),
    rv("t3", "tabelog", 3.0, "2024-11-17", "いい雰囲気だが普通"),
    rv("t4", "tabelog", 3.0, "2020-10-28", "普通でした"),
    rv("t5", "tabelog", 1.5, "2020-10-23", "対応が残念でした"),
    rv("t6", "tabelog", 3.6, null, "", { visit_month: "2026-09", details: { origin: "owner_pickup" } }),
    rv("t7", "tabelog", 4.0, null, "", { visit_month: "2026-09", details: { origin: "owner_pickup" } }),
    rv("t8", "tabelog", 4.0, null, "", { visit_month: "2026-03", details: { origin: "owner_pickup" } }),
    rv("i1", "ikyu", 5, "2026-08-23", "最高の記念日になりました"),
    rv("i2", "ikyu", 4.5, "2026-08-02", "また行きます"),
    rv("i3", "ikyu", 3.5, "2026-07-15", "ワインペアリングの量が少なめでした"),
    rv("i4", "ikyu", 4.5, "2025-07-24"),
    rv("i5", "ikyu", 3, "2020-03-16", "普通"),
    rv("i6", "ikyu", 2, "2020-01-26", "接客が残念"),
  ],
};
// 共有されたレポートの期間（M-talk の既定の期間）
const ctx = { store: "all", from: "2026-07-02", to: "2026-09-29" };
const tool = (name, args) => JSON.parse(runTool(ds, name, args, ctx));

test("Q1「最新の口コミ」: 全期間の新しい順。投稿日の無い食べログ（来店2026-09）も来店月で並び、本文なしと分かる", () => {
  const r = tool("get_reviews", { filter: "recent", all_time: true, limit: 5 });
  assert.equal(r.period, "全期間");
  assert.deepEqual(r.reviews.map((x) => [x.site, x.date, x.visitMonth ?? null, x.rating]), [
    ["食べログ", null, "2026-09", 3.6], ["食べログ", null, "2026-09", 4], ["一休.comレストラン", "2026-08-23", null, 5],
    ["一休.comレストラン", "2026-08-02", null, 4.5], ["一休.comレストラン", "2026-07-15", null, 3.5],
  ]);
  assert.equal(r.reviews[0].dateNote, "投稿日不明（来店 2026-09）");
  assert.equal(r.reviews[0].hasText, false);
  assert.equal(r.reviews[0].text, null);
  assert.ok(r.reviews[0].textNote);
  assert.equal(r.reviews[2].hasText, true);
  const st = tool("get_review_stats", { all_time: true });
  assert.equal(st.bySource["食べログ"].latestPostedDate, "2026-06-10");
  assert.equal(st.bySource["一休.comレストラン"].latestPostedDate, "2026-08-23");
});

test("Q2「悪い口コミ」: 期間内の低評価は0件（期間内の口コミ数と取り違えない）、全期間は食べログ3・一休2", () => {
  const p = tool("get_reviews", { filter: "low_rating" });
  assert.equal(p.period, "2026-07-02 〜 2026-09-29");
  assert.equal(p.filterDefinition, "評価3.0以下");
  assert.equal(p.matched, 0); // 旧実装はここが期間内の全件数（3）だった
  assert.ok(p.reviewsInPeriod >= 3);
  assert.deepEqual(p.reviews, []);
  assert.match(p.answerHint, /0件/);
  const a = tool("get_reviews", { filter: "low_rating", all_time: true });
  assert.equal(a.matched, 5);
  assert.deepEqual(a.matchedBySite, { "食べログ": 3, "一休.comレストラン": 2 });
  assert.ok(a.reviews.every((x) => x.rating <= 3 && x.hasText));
  // 期間内でいちばん低いのは一休 7/15 の ★3.5（低評価ではない）
  const worst = tool("get_reviews", { filter: "lowest" });
  assert.deepEqual([worst.reviews[0].site, worst.reviews[0].date, worst.reviews[0].rating], ["一休.comレストラン", "2026-07-15", 3.5]);
});

test("Q3「食べログですか」: 期間内の食べログの低評価は0件、全期間は3件（2020-10-23 ★1.5 など）", () => {
  const p = tool("get_reviews", { filter: "low_rating", source: "tabelog" });
  assert.equal(p.matched, 0);
  const a = tool("get_reviews", { filter: "low_rating", source: "tabelog", all_time: true });
  assert.equal(a.matched, 3);
  assert.deepEqual(a.reviews.map((x) => [x.date, x.rating]).sort(), [["2020-10-23", 1.5], ["2020-10-28", 3], ["2024-11-17", 3]]);
});

test("評価の区分: 3.5 は「3.5〜3.9」で、低評価（3.0以下）に数えない", () => {
  assert.equal(isLowRating({ rating: 3 }), true);
  assert.equal(isLowRating({ rating: 3.5 }), false);
  assert.equal(isLowRating({ rating: null }), false);
  assert.ok(RATING_BANDS.some((b) => b.key === "3.5〜3.9" && b.test(3.5) && !b.test(3.4)));
  const st = tool("get_review_stats", {});
  assert.equal(st.lowRatingCount, 0);
  assert.equal(st.ratingBands["3.5〜3.9"], 2); // 一休 3.5 と食べログ（来店9月）3.6
  assert.equal(st.ratingBands["3.0以下"], 0);
  assert.equal(st.distribution, undefined);
  assert.equal(st.undated, 2);
  assert.deepEqual(st.bySource["食べログ"].withText, 0);
  const all = reviewStats(ds.reviews);
  assert.equal(all.lowRatingCount, 5);
});

test("検証: 実際の誤答（期間内の口コミ数を『評価3以下が3件』）を見つける", () => {
  const ev = buildEvidence([tool("get_review_stats", {}), tool("get_reviews", { filter: "low_rating" })], { allowedText: "悪い口コミ" });
  const wrong = "2026-07-02〜2026-09-29の期間で、評価3以下の口コミが3件あります。\nただし本文は取得できませんでした。";
  const r = verifyAnswer(wrong, ev);
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.map((i) => [i.index, i.raw]), [[0, "3件"]]);
  assert.match(r.issues[0].reason, /0 件/);
  const right = "2026-07-02〜2026-09-29の期間では、評価3.0以下の口コミは0件です。\nいちばん低いのは一休.comレストランの2026-07-15（★3.5）です。";
  const ev2 = buildEvidence([tool("get_review_stats", {}), tool("get_reviews", { filter: "low_rating" }), tool("get_reviews", { filter: "lowest" })]);
  assert.deepEqual(verifyAnswer(right, ev2).issues, []);
});

test("検証: サイトと日付・評価の取り違え、関数の結果に無い日付を見つけ、正しい回答は通す", () => {
  const ev = buildEvidence([tool("get_reviews", { filter: "recent", all_time: true, limit: 6 })], { allowedText: "最新の口コミ" });
  const mis = verifyAnswer("最新の口コミは食べログの2026-08-23（★5）です。", ev);
  assert.deepEqual(mis.issues.map((i) => i.raw).sort(), ["2026-08-23", "5"]);
  assert.equal(verifyAnswer("一休.comレストランの2026-09-15の口コミが最新です。", ev).ok, false);
  const good = [
    "全期間で投稿日がいちばん新しいのは、一休.comレストランの2026-08-23（★5）です。〔T1〕",
    "食べログには投稿日が不明で来店2026年9月の口コミが2件（評価3.6・4.0、本文なし）あります。〔T1〕",
    "・一休.comレストラン 2026-08-02 ★4.5",
    "・一休.comレストラン 7/15 ★3.5（ワインペアリングの量が少なめ）",
  ].join("\n");
  assert.deepEqual(verifyAnswer(good, ev).issues, []);
});

test("検証: 会話履歴（過去の回答）は根拠にならない。（推測）の行は照合から外す", () => {
  const history = "直近3ヶ月で評価3以下の口コミは3件です";
  const ev = buildEvidence([tool("get_reviews", { filter: "low_rating" })]); // 履歴は渡さない
  assert.equal(verifyAnswer("前回お伝えしたとおり、評価3以下の口コミは3件です。", ev).ok, false);
  assert.equal(buildEvidence([history]).numbers.includes(3), true); // 履歴を入れれば通ってしまう（だから入れない）
  assert.equal(verifyAnswer("（推測）9月は来店が増えて口コミが12件ほど届くかもしれません。", ev).ok, true);
  assert.equal(extractClaims("（推測）12件")[0].inference, true);
});

test("後処理: 推測の言い回しに（推測）を付け、引用〔T1〕を消し、対象のサイト・期間を補う", () => {
  assert.equal(labelSpeculation("量への不満が原因と考えられます"), "量への不満が原因と考えられます（推測）");
  assert.equal(labelSpeculation("（推測）量への不満かもしれません"), "（推測）量への不満かもしれません");
  assert.equal(labelSpeculation("## おそらく"), "## おそらく");
  assert.equal(stripCitations("0件です〔T1〕。平均は4.1です[T2, T3]"), "0件です。平均は4.1です");
  const scopes = [{ sites: "食べログ・一休.comレストラン", period: "2026-07-02 〜 2026-09-29" }];
  assert.equal(ensureScopeMention("低評価は0件です", scopes), "低評価は0件です\n\n（対象: 食べログ・一休.comレストラン・2026-07-02 〜 2026-09-29）");
  assert.equal(ensureScopeMention("全期間では5件です", scopes), "全期間では5件です");
  assert.equal(ensureScopeMention("わかりません", scopes), "わかりません");
  assert.equal(hasClaims(SAFE_NO_DATA_ANSWER), false);
  assert.match(SAFE_NO_DATA_ANSWER, /わかりません/);
  assert.equal(sanitizeAnswer("評価3以下は3件です\n本文は確認できませんでした。", [{ index: 0 }]), `本文は確認できませんでした。\n\n${SANITIZED_NOTE}`);
  assert.equal(sanitizeAnswer("評価3以下は3件です", [{ index: 0 }]), SAFE_NO_DATA_ANSWER);
});

test("プロンプト: 事実は関数の結果だけ・わからない・（推測）・全期間・サイトと期間、M-talk は過去の返事を疑う", () => {
  const p = systemPrompt("2026-10-01");
  for (const w of ["わかりません", "（推測）", "all_time", "期間", "hasText"]) assert.ok(p.includes(w), w);
  assert.match(mtalkChatPrompt(), /過去の返事は間違っている可能性/);
  const report = { title: "R", store_name: "全店舗", period_from: "2026-07-02", period_to: "2026-09-29", markdown: "## 要約\n評価3以下は3件（AIの文）\n| サイト | PV |\n| --- | ---: |\n| 食べログ | 100 |" };
  assert.match(reportContextMessage(report), /all_time/);
  assert.equal(reportFactLines(report), "| サイト | PV |\n| --- | ---: |\n| 食べログ | 100 |");
  assert.equal(reportFactLines(null), "");
});

// ---------- answerWithTools（OpenAI は偽の fetch） ----------
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolReply = (...calls) => ({ body: { model: "m", usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }] } });
const textReply = (content) => ({ body: { model: "m", usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] } });
const fakeFetch = (responses, seen) => async (url, init) => {
  seen.push(JSON.parse(init.body));
  const next = responses.shift();
  if (!next) throw new Error("unexpected call");
  return new Response(JSON.stringify(next.body), { status: 200 });
};
const cfg = { apiKey: "k", model: "gpt-6-luna", reasoningEffort: "low" };
const history = [{ role: "user", content: "悪い口コミ" }, { role: "assistant", content: "評価3以下の口コミが3件あります" }];
const ask = (question, fetchImpl, extra = {}) => answerWithTools(cfg, { ds, ctx, question, evidenceTexts: ["期間: 2026-07-02〜2026-09-29"],
  messages: [{ role: "system", content: "s" }, ...history, { role: "user", content: question }], ...extra }, { fetchImpl });

test("answerWithTools: 関数を呼ばずに数値を答えたら関数を必ず呼ばせてやり直す", async () => {
  const seen = [];
  const r = await ask("食べログですか", fakeFetch([
    textReply("食べログの評価3以下は3件です"),
    toolReply(call("c1", "get_reviews", { filter: "low_rating", source: "tabelog", all_time: true })),
    textReply("全期間では、食べログの評価3.0以下の口コミは3件です〔T1〕（2020-10-23 ★1.5 など）。"),
  ], seen));
  assert.equal(seen[1].tool_choice, "required");
  assert.match(seen[1].messages.at(-1).content, /関数を呼んで確認/);
  assert.equal(r.verification.status, "verified");
  assert.equal(r.answer, "全期間では、食べログの評価3.0以下の口コミは3件です（2020-10-23 ★1.5 など）。");
  assert.equal(JSON.parse(seen[2].messages.find((m) => m.role === "tool").content).ref, "T1");
});

test("answerWithTools: やり直しても関数を呼ばなければ「わかりません」", async () => {
  const seen = [];
  const r = await ask("悪い口コミ", fakeFetch([textReply("評価3以下は3件です"), textReply("やはり3件です")], seen));
  assert.equal(r.answer, SAFE_NO_DATA_ANSWER);
  assert.equal(r.verification.status, "no_data");
  // 数値の無い回答（聞き返し・案内）は関数なしでもそのまま
  const r2 = await ask("こんにちは", fakeFetch([textReply("こんにちは。口コミやPVについて質問してください。")], []));
  assert.equal(r2.answer, "こんにちは。口コミやPVについて質問してください。");
});

test("answerWithTools: 実際の誤答（Q2）は検証で見つかり、指摘つきで1回書き直す", async () => {
  const seen = [];
  const r = await ask("悪い口コミ", fakeFetch([
    toolReply(call("c1", "get_review_stats", {}), call("c2", "get_reviews", { filter: "low_rating" })),
    textReply("2026-07-02〜2026-09-29では、評価3以下の口コミが3件あります。本文は取得できませんでした。"),
    toolReply(call("c3", "get_reviews", { filter: "lowest", limit: 3 })), // 指摘のあと関数を呼び直せる
    textReply("2026-07-02〜2026-09-29では、評価3.0以下の口コミは0件です。\nいちばん低いのは一休.comレストランの2026-07-15（★3.5）です。\n量への不満が原因と考えられます"),
  ], seen));
  const feedback = seen[2].messages.at(-1);
  assert.equal(feedback.role, "user");
  assert.match(feedback.content, /【自動検証】[\s\S]*「3件」/);
  assert.equal(r.verification.status, "regenerated");
  assert.equal(r.answer.split("\n").at(-1), "量への不満が原因と考えられます（推測）");
  assert.deepEqual(r.calls.map((c) => c.args.filter ?? null), [null, "low_rating", "lowest"]);
});

test("answerWithTools: 書き直しても合わなければ合わない行を消し、確認できなかったと明記する", async () => {
  const r = await ask("悪い口コミ", fakeFetch([
    toolReply(call("c1", "get_reviews", { filter: "low_rating" })),
    textReply("評価3以下の口コミが3件あります。\n2026-07-02〜2026-09-29の口コミを確認しました。"),
    textReply("評価3以下の口コミが3件あります。\n2026-07-02〜2026-09-29の口コミを確認しました。"),
  ], []));
  assert.equal(r.verification.status, "sanitized");
  assert.equal(r.answer, `2026-07-02〜2026-09-29の口コミを確認しました。\n\n${SANITIZED_NOTE}`);
});

test("answerWithTools: 締め切りが近ければ書き直さずに安全な形にし、時間切れなら 504", async () => {
  let t = 0;
  const now = () => t;
  const responses = [toolReply(call("c1", "get_reviews", { filter: "low_rating" })), textReply("評価3以下の口コミが3件あります。")];
  const seen = [];
  const fetchImpl = async (url, init) => { t += 40_000; return fakeFetch(responses, seen)(url, init); };
  const r = await answerWithTools(cfg, { ds, ctx, question: "悪い口コミ", messages: [{ role: "user", content: "悪い口コミ" }], deadlineMs: 80_000 }, { fetchImpl, now });
  assert.equal(seen.length, 2); // 残り0秒なので書き直さない
  assert.equal(r.answer, SAFE_NO_DATA_ANSWER);
  assert.equal(r.verification.status, "sanitized");
  // 1回の呼び出しの上限も残り時間に合わせる（line_report の100秒を超えない）
  t = 0;
  await assert.rejects(answerWithTools(cfg, { ds, ctx, messages: [{ role: "user", content: "x" }], deadlineMs: ANSWER_GUARD.minCallMs - 1 }, { fetchImpl, now }), (e) => e.status === 504);
});

// ---------- レポートの文章 ----------
test("レポート: 集計データに無い数値の文を見つけて削り、推測に印を付ける", () => {
  const facts = { period: { from: "2026-07-02", to: "2026-09-29" }, reviews: tool("get_review_stats", {}) };
  const ev = buildEvidence([JSON.stringify(facts)]);
  const ai = normalizeReportAi(JSON.stringify({
    title: "t", summary: ["期間内の口コミは5件で、平均評価は4.12です。", "評価3以下の口コミが3件ありました。"],
    kpiComment: "", siteComment: "", reviewSentiment: "量への不満が出ている可能性があります", unrepliedComment: "",
    positiveThemes: [], negativeThemes: [], recommendations: [{ title: "返信", detail: "未返信の3件に返信する" }],
  }));
  const check = verifyReportAi(ai, ev);
  assert.equal(check.ok, false);
  const paths = check.issues.map((i) => JSON.stringify(i.path));
  assert.ok(paths.includes('["summary",1]'));
  assert.ok(!paths.includes('["summary",0]'));
  const fixed = labelReportSpeculation(sanitizeReportAi(ai, check.issues));
  assert.equal(fixed.summary[0], "期間内の口コミは5件で、平均評価は4.12です。");
  assert.ok(!fixed.summary.some((s) => s.includes("3件ありました")));
  assert.match(fixed.reviewSentiment, /（推測）$/);
  assert.equal(verifyReportAi(fixed, ev).issues.filter((i) => i.path[0] === "summary").length, 0);
});
