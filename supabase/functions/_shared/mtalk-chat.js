// M-talk の「AI分析」Bot との1対1で、利用者の質問に AI分析（ai-analyst の Q&A と同じモデル・同じ7つの関数）で答えるための純粋ロジック（Node/Deno 共通）。
// - 呼び出し元は line_report の mtalk-external-post（/chat-dispatch）だけ。認証は gourmet→M-talk と同じ GOURMET_MTALK_TOKEN と HMAC 署名
//   （Authorization: Bearer + X-Mtalk-Timestamp ±5分 + X-Mtalk-Signature = HMAC-SHA256("v1:<秒>:<METHOD>:<path>:<本文>")）。逆方向でも同じ規則。
// - M-talk 側の利用者には gourmet のログインが無いため、読み込むデータの持ち主（gourmet の user_id）はサーバーで決める
//   （その1対1へ最後にレポートを送った gourmet 利用者 → 無ければ INGEST_USER_ID）。データは user_id で絞った SELECT だけ（scopedReadClient）。
// - OPENAI_API_KEY・GOURMET_MTALK_TOKEN は応答・ログ・エラーへ出さない。
import { AI_LIMITS, validateHistory } from "./ai-analyst.js";
import { signMtalkRequest } from "./mtalk-share.js";

export const MTALK_CHAT_LIMITS = { perHour: AI_LIMITS.askPerHour, historyMessages: 10, reportChars: 8000, replyChars: 1900, replyChunks: 3, clockSkewSeconds: 300 };
export const MTALK_CHAT_PATH = "/mtalk-chat";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export class MtalkChatError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** 文字列の定数時間比較（長さの違いは即 false。値そのものは比較結果以外に使わない）。 */
export function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** line_report → gourmet の要求を検証する。どれか1つでも欠けたら false（どれが違ったかは返さない）。 */
export async function verifyMtalkRequest({ authorization, timestamp, signature, method, path, body }, secret, nowMs = Date.now()) {
  const expected = String(secret ?? "").trim();
  if (expected.length < 32) return false; // 未設定・弱い値では常に拒否
  const provided = String(String(authorization ?? "").trim().match(/^Bearer\s+(.+)$/i)?.[1] ?? "").trim();
  const tokenOk = constantTimeEqual(provided, expected);
  const ts = String(timestamp ?? "").trim();
  if (!/^\d{9,12}$/.test(ts)) return false;
  if (!(Math.abs(nowMs / 1000 - Number(ts)) <= MTALK_CHAT_LIMITS.clockSkewSeconds)) return false;
  const want = await signMtalkRequest(expected, { timestamp: ts, method, path, body: body ?? "" });
  const sigOk = constantTimeEqual(String(signature ?? "").trim().toLowerCase(), want);
  return tokenOk && sigOk;
}

const clean = (v, max) => String(v ?? "").normalize("NFC").replace(CONTROL, "").trim().slice(0, max);

/** { mtalk_user_id, mtalk_group_id, message_id, question, history[] } */
export function validateMtalkChatInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MtalkChatError("入力形式が不正です");
  const userId = String(raw.mtalk_user_id ?? "");
  if (!UUID.test(userId)) throw new MtalkChatError("M-talk利用者IDが不正です");
  const groupId = Number(raw.mtalk_group_id);
  const messageId = Number(raw.message_id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new MtalkChatError("M-talkのトークIDが不正です");
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new MtalkChatError("メッセージIDが不正です");
  const question = clean(raw.question, AI_LIMITS.question + 1);
  if (!question) throw new MtalkChatError("質問が空です");
  if (question.length > AI_LIMITS.question) throw new MtalkChatError(`質問は${AI_LIMITS.question}文字以内で送ってください`);
  let history;
  try { history = validateHistory(Array.isArray(raw.history) ? raw.history.slice(-MTALK_CHAT_LIMITS.historyMessages) : []); }
  catch { throw new MtalkChatError("会話履歴の形式が不正です"); }
  return { mtalkUserId: userId.toLowerCase(), groupId, messageId, question, history };
}

/** M-talk はMarkdownを表示しないため、書式の指示を足す（systemPrompt の後に置く）。 */
export function mtalkChatPrompt() {
  return [
    "この会話は社内チャット M-talk の「AI分析」Bot との1対1です。回答はチャットで読みやすい短めの日本語のプレーンテキストにしてください。",
    "- Markdownの表・見出し記号（#）・太字（**）は使わない。箇条書きは「・」、番号は「1.」を使う。",
    "- まず結論を1〜2文で。続けて根拠の数値を箇条書きで。全体でおおむね800文字以内。",
    "- 扱うのは食べログ・一休.comレストランなどのPV・予約・口コミの分析だけ。それ以外の依頼には、できることを短く案内する。",
    "- 最新データの取り直し（再取得・スクレイピング）やPDFレポートの作成はここではできない。必要なら Review Command Center のAI分析画面を案内する。",
  ].join("\n");
}

/** 直近に届いたレポートの要約を会話の前提として渡す（本文は上限つき）。 */
export function reportContextMessage(report) {
  if (!report) return null;
  const md = String(report.markdown ?? "");
  const body = md.length > MTALK_CHAT_LIMITS.reportChars ? `${md.slice(0, MTALK_CHAT_LIMITS.reportChars)}\n…（以下省略）` : md;
  return [
    "このトークには、次のAI分析レポートが届いています。利用者の質問がこのレポートを指している場合は、その内容と期間・店舗を前提に答えてください。",
    `レポート: ${clean(report.title, 200)}（${clean(report.store_name, 200)}、${report.period_from}〜${report.period_to}）`,
    "---",
    body,
  ].join("\n");
}

/** Markdown寄りの回答を M-talk 向けのプレーンテキストにする（表は「a / b / c」の行、見出しは【】）。 */
export function toMtalkPlainText(markdown) {
  const out = [];
  for (const raw of String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    let line = raw.replace(/\s+$/, "");
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // 表の区切り行
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" / ");
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) line = `【${h[1].trim()}】`;
    line = line.replace(/^(\s*)[-*+]\s+/, "$1・").replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1");
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1（$2）");
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(CONTROL, "").trim();
}

/** M-talk の1通の上限（2000文字）に収まるよう段落で分ける（最大 replyChunks 通、超えた分は省略を明記）。 */
export function splitReply(text, { max = MTALK_CHAT_LIMITS.replyChars, chunks = MTALK_CHAT_LIMITS.replyChunks } = {}) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const parts = [];
  let rest = s;
  while (rest.length > max && parts.length < chunks - 1) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > max) rest = `${rest.slice(0, max - 40).trim()}\n…（長いため省略しました。質問を絞ってください）`;
  parts.push(rest);
  return parts.filter(Boolean);
}

/**
 * service_role のクライアントから、指定した gourmet 利用者の行だけを読む SELECT 専用のクライアントを作る。
 * ai-data.js の読み込み（from(t).select(...)）はこのまま動き、すべての要求に user_id = <owner> が付く。insert/update/delete/rpc は提供しない。
 */
export function scopedReadClient(admin, userId) {
  if (!UUID.test(String(userId ?? ""))) throw new MtalkChatError("データの持ち主が不正です", 500);
  return Object.freeze({
    from(table) {
      const qb = admin.from(table);
      return Object.freeze({ select: (...args) => qb.select(...args).eq("user_id", userId) });
    },
  });
}

/** データの持ち主: その1対1へ最後にレポートを送った gourmet 利用者 → 無ければ既定（INGEST_USER_ID）。 */
export function resolveDataOwner(latestShare, fallbackUserId) {
  if (latestShare && UUID.test(String(latestShare.user_id ?? ""))) return { userId: String(latestShare.user_id), reportId: latestShare.report_id ?? null, via: "share" };
  if (UUID.test(String(fallbackUserId ?? "").trim())) return { userId: String(fallbackUserId).trim(), reportId: null, via: "default" };
  return null;
}
