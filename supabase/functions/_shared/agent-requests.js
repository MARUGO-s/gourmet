// アプリ → Grok Bot の取得依頼（agent_requests）。Node/Edge/ブラウザ共通の純粋モジュール。
import { SOURCE_IDS } from "./sources.js";

export const REQUEST_ACTIONS = ["sync_now", "fetch_metrics", "fetch_reviews", "backfill"];
export const REQUEST_STATUSES = ["queued", "claimed", "done", "failed"];
// 依頼の出どころ（migration 019）。mtalk_live は M-talk の「最新を調べる」（24時間処理・他より先に取得）
export const REQUEST_ORIGINS = ["app", "schedule", "mtalk_live"];
export const ORIGIN_LABELS = { app: "アプリ", schedule: "自動取得", mtalk_live: "M-talk" };
export const ACTION_LABELS = { sync_now: "今すぐ取得（全項目）", fetch_metrics: "PV・予約などの数値", fetch_reviews: "口コミ", backfill: "過去分の取得" };
export const STATUS_LABELS = { queued: "依頼中", claimed: "取得中", done: "完了", failed: "失敗" };
// 失敗の種類（migration 020）。needs_relogin だけ、M-talk・アプリに「ログイン情報を更新」のボタンを出す。
// needs_human_check = ログインで「私は人間です」の確認を求められた（Grok Bot が次の回に自動でやり直す。ボタンは出さない）
export const FAILURE_KINDS = ["needs_relogin", "needs_human_check", "other"];
export const FAILURE_KIND_LABELS = { needs_relogin: "ログイン情報の更新が必要", needs_human_check: "「私は人間です」の確認が必要", other: "その他" };
// Grok Bot の確認間隔（目安）。取得はこの間隔で拾われる。
export const AGENT_POLL_MINUTES = 5;

const fail = (message) => { throw new Error(message); };
const validMonth = (v) => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

// ブラウザからの依頼内容を検証（DB側でも制約・件数制限あり）
export function validateRequestInput(input, currentMonth) {
  const source = input?.source, action = input?.action ?? "sync_now";
  const storeId = typeof input?.storeId === "string" ? input.storeId.trim() : "";
  if (!SOURCE_IDS.includes(source)) fail("サイトが不正です");
  if (!REQUEST_ACTIONS.includes(action)) fail("依頼内容が不正です");
  if (!/^[0-9A-Za-z_-]{0,40}$/.test(storeId) || (source === "ikyu" && !/^\d{6}$/.test(storeId))) fail(source === "ikyu" ? "一休は店舗ID（6桁）を指定してください" : "店舗コードが不正です");
  const params = {};
  if (action === "backfill") {
    const { fromMonth, toMonth } = input?.params ?? {};
    if (!validMonth(fromMonth) || (toMonth != null && !validMonth(toMonth))) fail("過去分の取得は開始月（YYYY-MM）を指定してください");
    const to = toMonth ?? currentMonth;
    if (fromMonth > to || (currentMonth && to > currentMonth)) fail("取得期間が不正です");
    const span = (Number(to.slice(0, 4)) - Number(fromMonth.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(fromMonth.slice(5));
    if (span >= 120) fail("過去分の取得は120か月以内で指定してください");
    Object.assign(params, { fromMonth, toMonth: to });
  }
  const note = input?.params?.note;
  if (note != null) {
    if (typeof note !== "string" || note.length > 200) fail("メモは200文字以内です");
    if (note.trim()) params.note = note.trim();
  }
  return { source, store_id: storeId, action, params };
}

// 失敗理由の文 → 種類（--kind の無い古い報告と、migration 020 の既存の失敗の埋め直しと同じ規則。「私は人間です」を先に見る）
const HUMAN_CHECK_PATTERN = /私は人間|人間です|ロボットではありません|画像認証|captcha|recaptcha|turnstile|human/i;
const RELOGIN_PATTERN = /再ログイン|ログイン(?:でき|に失敗|切れ|が必要)|パスワードが(?:通ら|違|誤)|ID・パスワード|login|session|password/i;
export function classifyFailure(error) {
  const s = String(error ?? "");
  if (HUMAN_CHECK_PATTERN.test(s)) return "needs_human_check";
  if (RELOGIN_PATTERN.test(s)) return "needs_relogin";
  return "other";
}
// 行の失敗の種類（列が無い・空の古い行は理由の文から）
export const failureKindOf = (r) => (r?.status === "failed" ? (FAILURE_KINDS.includes(r.failure_kind) ? r.failure_kind : classifyFailure(r.error)) : null);

// DB行 → 画面・エージェント向け（キャメルケース）
export function publicRequest(r) {
  return {
    id: r.id, source: r.source, storeId: r.store_id, action: r.action, params: r.params ?? {}, status: r.status, origin: r.origin ?? "app",
    requestedAt: r.requested_at, claimedAt: r.claimed_at ?? null, finishedAt: r.finished_at ?? null,
    claimedBy: r.claimed_by ?? null, attempts: r.attempts ?? 0, result: r.result ?? null, error: r.error ?? null, failureKind: failureKindOf(r),
  };
}

// エージェントの完了・失敗報告を検証
export function validateFinish(input, outcome) {
  if (!/^[0-9a-f-]{36}$/.test(String(input?.id ?? "")) || !/^[0-9a-f-]{36}$/.test(String(input?.claimId ?? ""))) fail("id / claimId が不正です");
  if (outcome === "done") {
    const result = input.result ?? {};
    if (typeof result !== "object" || Array.isArray(result) || JSON.stringify(result).length > 20000) fail("result は20000文字以内のオブジェクトです");
    return { id: input.id, claimId: input.claimId, result, error: null };
  }
  const error = String(input?.error ?? "").trim();
  if (!error || error.length > 1000) fail("error（失敗理由）を1〜1000文字で指定してください");
  const kind = input?.failureKind ?? null;
  if (kind != null && !FAILURE_KINDS.includes(kind)) fail(`failureKind は ${FAILURE_KINDS.join(" / ")} のどれかです`);
  return { id: input.id, claimId: input.claimId, failureKind: kind ?? classifyFailure(error), result: input.result && typeof input.result === "object" && !Array.isArray(input.result) && JSON.stringify(input.result).length <= 20000 ? input.result : null, error };
}
