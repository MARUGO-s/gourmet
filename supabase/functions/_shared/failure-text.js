// 取得の失敗を利用者（M-talk・アプリの店舗スタッフ）へ見せる文（Node/Deno/ブラウザ共通）。
//
//   利用者に見せる文は failure_kind（needs_relogin / needs_human_check / other）× サイト × 店舗から、決まった文だけで作る。
//   Grok Bot が --fail で書いた理由の文（agent_requests.error）は調査用で、M-talk へは出さない（アプリでは「詳細」を開いたときだけ）。
//   念のため、M-talk へ送る本文は safeParts で内部の言葉（computerUse・サブエージェント・Shell・claim など）を含む行を落としてから送る。

export const PUBLIC_FAILURE_LABELS = {
  needs_relogin: "ログイン情報の確認が必要です",
  needs_human_check: "ログインで「私は人間です」の確認を求められました",
  other: "今回は取得できませんでした（こちらの不具合です。次の回にやり直します）",
  // 依頼が時間内に終わらなかった（取得中・依頼中のまま）／依頼そのものができなかった
  unfinished: "時間内に取得が終わりませんでした（こちらの不具合です。次の回にやり直します）",
  not_queued: "今回は取得を依頼できませんでした（時間をおいてもう一度お試しください）",
};

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const clip = (v, max) => String(v ?? "").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);

/** 失敗の種類 → 利用者向けの短い文（店舗・サイト無し）。不明な種類は other。 */
export function publicFailureLabel(kind) {
  return PUBLIC_FAILURE_LABELS[kind] ?? PUBLIC_FAILURE_LABELS.other;
}

/**
 * 利用者向けの1行: 「一休（BISTRO CAVACAVA）：ログイン情報の確認が必要です」。
 * site はサイトの表示名（一休・食べログ）、kind は failure_kind か unfinished / not_queued。理由の文（error）は受け取らない。
 */
export function publicFailureText({ site, storeName, kind }) {
  return `${clip(site, 40) || "サイト"}（${clip(storeName, 100) || "店舗"}）：${publicFailureLabel(kind)}`;
}

// 利用者に見せてはいけない内部の言葉（実行の仕組み・道具・認証まわり）。ふつうの回答に出てこない語だけにする
export const INTERNAL_TERMS = new RegExp([
  "computer\\s*-?\\s*use", "sub-?agents?", "サブエージェント", "executor", "エグゼキュータ", "親エージェント", "この実行環境",
  "\\bshell\\b", "\\bclaim(?:[-_ ]?ids?)?\\b", "claimid", "playwright", "puppeteer", "xdotool", "devtools", "\\bcdp\\b", "\\bmcp\\b",
  "ingest_token", "agent-queue", "stage_cred", "--fail\\b", "--kind\\b", "x-ingest-token", "service_role",
].join("|"), "i");

export const hasInternalTerms = (text) => INTERNAL_TERMS.test(String(text ?? ""));

/** 内部の言葉を含む行を落とす（行ごと。言い換えはしない）。 */
export function scrubInternal(text) {
  return String(text ?? "").split("\n").filter((line) => !INTERNAL_TERMS.test(line)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const SCRUBBED_FALLBACK = "（回答を表示できませんでした。もう一度質問してください）";

/** M-talk へ送る本文（parts）の最後の確認。空になった部分は除き、すべて空なら決まった文を1つ返す。 */
export function safeParts(parts) {
  const out = (Array.isArray(parts) ? parts : [parts]).map(scrubInternal).filter(Boolean);
  return out.length ? out : [SCRUBBED_FALLBACK];
}
