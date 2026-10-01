// 取得の失敗の利用者向けの文（failure-text.js）と、M-talk・アプリへ理由の文（内部の言葉）が出ないこと
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_FAILURE_LABELS, SCRUBBED_FALLBACK, hasInternalTerms, publicFailureLabel, publicFailureText, safeParts, scrubInternal } from "../../supabase/functions/_shared/failure-text.js";
import { liveSummary } from "../../supabase/functions/_shared/mtalk-live.js";
import { followupMessage } from "../../supabase/functions/_shared/mtalk-followups.js";

const R1 = "82e85f09-81ff-488e-a78d-ebbcce02379d";
const R2 = "a165f4ab-8cd1-4f95-b11a-6dc2948d2a49";
// 10/1 16:11 に M-talk へそのまま出てしまった理由の文（と、15:13 の食べログの文）
const LEAK_IKYU = "ブラウザ用computerUseサブエージェントがこの実行環境で利用できず、ルール上Shellからの操作も不可のため取得不能";
const LEAK_TABELOG = "食べログ: 実行サブエージェントにcomputerUseが無く、ブラウザ取得できませんでした。親エージェントで再実行が必要です";

test("fixed templates per kind × site × store", () => {
  assert.equal(publicFailureText({ site: "一休", storeName: "BISTRO CAVACAVA", kind: "needs_relogin" }), "一休（BISTRO CAVACAVA）：ログイン情報の確認が必要です");
  assert.equal(publicFailureText({ site: "一休", storeName: "BISTRO CAVACAVA", kind: "other" }), "一休（BISTRO CAVACAVA）：今回は取得できませんでした（こちらの不具合です。次の回にやり直します）");
  assert.equal(publicFailureText({ site: "食べログ", storeName: "", kind: "needs_human_check" }), "食べログ（店舗）：ログインで「私は人間です」の確認を求められました");
  assert.equal(publicFailureLabel("bogus"), PUBLIC_FAILURE_LABELS.other);
  assert.equal(publicFailureLabel(null), PUBLIC_FAILURE_LABELS.other);
  for (const label of Object.values(PUBLIC_FAILURE_LABELS)) assert.equal(hasInternalTerms(label), false, label);
});

test("the 16:11 reply: raw --fail text never reaches M-talk (live answer + followup)", () => {
  const lookup = { question: "今月の予約は？", targets: [
    { source: "ikyu", storeId: "112789", storeName: "BISTRO CAVACAVA", requestId: R2 },
    { source: "tabelog", storeId: "", storeName: "BISTRO CAVACAVA", requestId: R1 },
  ] };
  const s = liveSummary(lookup, [
    { id: R2, status: "failed", error: LEAK_IKYU, failure_kind: "other" },
    { id: R1, status: "failed", error: LEAK_TABELOG, failure_kind: null }, // 種類の無い古い行
  ]);
  assert.match(s.header, /最新のデータを取得できませんでした。前回までに取得したデータで答えます。/);
  assert.match(s.header, /・一休（BISTRO CAVACAVA）：今回は取得できませんでした（こちらの不具合です。次の回にやり直します）/);
  assert.match(s.header, /・食べログ（BISTRO CAVACAVA）：今回は取得できませんでした/);
  for (const text of [s.header, s.system]) {
    assert.equal(hasInternalTerms(text), false, text);
    assert.ok(!text.includes("ブラウザ") && !text.includes("ルール上"), text);
  }
  assert.equal(s.links.length, 0);
  const f = followupMessage({ request: { id: R2, source: "ikyu", store_id: "112789", status: "failed", error: LEAK_IKYU, failure_kind: "other" }, storeName: "BISTRO CAVACAVA" });
  assert.equal(hasInternalTerms(f.text), false);
  assert.match(f.text, /・一休（BISTRO CAVACAVA）：今回は取得できませんでした/);
});

test("unfinished and not-queued targets get their own fixed text", () => {
  const lookup = { question: "q", targets: [
    { source: "ikyu", storeId: "112789", storeName: "B", requestId: R2 },
    { source: "tabelog", storeId: "", storeName: "B", enqueueError: "取得の依頼が多すぎるため依頼できませんでした" },
  ] };
  const s = liveSummary(lookup, [{ id: R2, status: "claimed", error: null }]);
  assert.match(s.header, /・一休（B）：時間内に取得が終わりませんでした/);
  assert.match(s.header, /・食べログ（B）：今回は取得を依頼できませんでした/);
});

test("defense in depth: lines with internal terms are dropped before posting", () => {
  for (const t of [LEAK_IKYU, LEAK_TABELOG, "computer use が無い", "subagent failed", "executor にて", "claimId 不一致", "claim not found", "Playwright で", "--fail で報告", "INGEST_TOKEN"]) {
    assert.equal(hasInternalTerms(t), true, t);
  }
  for (const t of ["今月の予約は12件です", "シェルフィッシュのコースが人気です", "Shellfish platter", "口コミの評価は3.6です", "一休（BISTRO CAVACAVA）：ログイン情報の確認が必要です", "SiteBot（Grok Bot）が次の回に自動でやり直します"]) {
    assert.equal(hasInternalTerms(t), false, t);
  }
  assert.equal(scrubInternal(`ご質問：「今月は？」\n最新のデータを取得できませんでした（${LEAK_IKYU}）。\n\n予約は12件です`), "ご質問：「今月は？」\n\n予約は12件です");
  assert.deepEqual(safeParts(["予約は12件です", LEAK_TABELOG]), ["予約は12件です"]);
  assert.deepEqual(safeParts([LEAK_IKYU]), [SCRUBBED_FALLBACK]);
  assert.deepEqual(safeParts("a\nb"), ["a\nb"]);
});
