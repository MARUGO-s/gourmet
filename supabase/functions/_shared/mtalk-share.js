// AI分析レポートを M-talk（line_report の mtalk-external-post）へ送るための純粋ロジック（Node/Deno 共通）。
// - M-talk 側の認証: Authorization: Bearer GOURMET_MTALK_TOKEN + X-Mtalk-Timestamp + X-Mtalk-Signature（HMAC-SHA256）。
//   署名の対象は "v1:<UNIX秒>:<METHOD>:<path>:<本文>"（line_report の _shared/mtalk_external_post.ts と同じ）。
// - GOURMET_MTALK_TOKEN・MTALK_API_URL は Edge Function の秘密情報だけにあり、ブラウザ・応答・ログ・エラーへ出さない。
// - カードに載せる内容は、保存済みレポートの集計（facts）とAIの要約（ai）から上限つきで作る（本文の全文は PDF）。

export const MTALK_SHARE_LIMITS = { perHour: 30, timeoutMs: 45_000, pdfMaxBytes: 8 * 1024 * 1024 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export class MtalkError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export const clip = (value, max) => {
  const s = String(value ?? "").normalize("NFC").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return [...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s;
};
const fmt = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v).toLocaleString("ja-JP"));
const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? null : `${v > 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const rating = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(2));
const plain = (s) => String(s ?? "").replace(/\*\*|__|`/g, "");

/** 設定（秘密情報）。値そのものは返さず、使う関数にだけ渡す。 */
export function mtalkConfig(env) {
  const url = String(env("MTALK_API_URL") ?? "").trim().replace(/\/+$/, "");
  const token = String(env("GOURMET_MTALK_TOKEN") ?? "").trim();
  let ok = false;
  try { const u = new URL(url); ok = u.protocol === "https:" && /\/mtalk-external-post$/.test(u.pathname); } catch { ok = false; }
  return { url, token, configured: ok && token.length >= 32 };
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function signMtalkRequest(token, { timestamp, method, path, body }) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1:${timestamp}:${method.toUpperCase()}:${path}:${body}`));
  return `v1=${toHex(sig)}`;
}

/** M-talk への要求。失敗時は利用者向けの日本語だけを持つ MtalkError（URL・トークン・応答本文は含めない）。 */
export async function mtalkRequest(config, method, path, payload, { fetchImpl = fetch, now = Date.now, timeoutMs = MTALK_SHARE_LIMITS.timeoutMs } = {}) {
  if (!config?.configured) throw new MtalkError("M-talk連携は未設定です（管理者がサーバーに接続情報を設定すると利用できます）", 503);
  const body = payload == null ? "" : JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1000));
  const signature = await signMtalkRequest(config.token, { timestamp, method, path, body });
  let res;
  try {
    res = await fetchImpl(`${config.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, "X-Mtalk-Timestamp": timestamp, "X-Mtalk-Signature": signature, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new MtalkError("M-talkに接続できませんでした。時間をおいて再度お試しください", 502);
  }
  const data = await res.json().catch(() => null);
  if (res.ok && data && typeof data === "object") return data;
  if (res.status === 404 && path === "/send") throw new MtalkError("送信先のM-talk利用者が見つからないか、利用停止中です。送信先を選び直してください", 404);
  if (res.status === 409) throw new MtalkError("同じ送信を処理中です。しばらくしてから再度お試しください", 409);
  if (res.status === 413) throw new MtalkError("PDFが大きすぎるため送信できませんでした", 413);
  if (res.status === 401) throw new MtalkError("M-talkとの接続設定を確認してください（認証に失敗しました）", 502);
  throw new MtalkError("M-talkへの送信を完了できませんでした。時間をおいて再度お試しください", 502);
}

export function normalizeRecipients(data) {
  return (Array.isArray(data?.recipients) ? data.recipients : [])
    .filter((r) => r && UUID.test(String(r.id)) && clip(r.username, 100))
    .map((r) => ({ id: String(r.id).toLowerCase(), username: clip(r.username, 100), stores: (Array.isArray(r.stores) ? r.stores : []).map((s) => clip(s, 60)).filter(Boolean).slice(0, 30) }))
    .slice(0, 3000);
}

export function validateShareInput(raw) {
  const id = raw && typeof raw === "object" ? raw.recipient_user_id ?? raw.recipientUserId : null;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("送信先を選んでください");
  return { recipientUserId: id.toLowerCase() };
}

/** 送信者の表示名（サーバーで決める。ブラウザからの値は使わない）。 */
export function senderLabel(user) {
  const m = user?.user_metadata ?? {};
  const name = clip(m.display_name || m.full_name || m.name || "", 60);
  const email = clip(user?.email ?? "", 120);
  return clip(name ? (email ? `${name}（${email}）` : name) : email || "Review Command Center の利用者", 80);
}

const jstDateTime = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 9 * 3600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
};

/** カードの内容（M-talk 側の上限: 項目10・要点5・提案5、各200文字）。 */
export function buildShareCard(report, { sender }) {
  const facts = report?.content?.facts ?? {};
  const ai = report?.content?.ai ?? {};
  const total = facts?.kpis?.total ?? {};
  const days = facts?.period?.days;
  const fields = [
    { label: "店舗", value: clip(report.storeName, 100) },
    { label: "期間", value: `${report.from}〜${report.to}${days ? `（${days}日間）` : ""}` },
  ];
  const pv = fmt(total.pv);
  if (pv) fields.push({ label: "PV", value: pct(total.pvChangePct) ? `${pv}（前期間比 ${pct(total.pvChangePct)}）` : pv });
  if (fmt(total.reservations)) fields.push({ label: "予約", value: `${fmt(total.reservations)}件` });
  if (total.newReviews != null) fields.push({ label: "新着口コミ", value: `${fmt(total.newReviews)}件${rating(facts?.reviewStats?.averageRating) ? `（平均 ★${rating(facts.reviewStats.averageRating)}）` : ""}` });
  if (rating(total.currentRating)) fields.push({ label: "最新の評価", value: `★${rating(total.currentRating)}（サイト平均）` });
  if (facts.unrepliedCount != null) fields.push({ label: "未返信", value: `${fmt(facts.unrepliedCount)}件` });
  const created = jstDateTime(report.createdAt);
  if (created) fields.push({ label: "作成", value: `${created}（日本時間）` });
  const highlights = (Array.isArray(ai.summary) ? ai.summary : []).map((s) => clip(plain(s), 200)).filter(Boolean).slice(0, 3);
  const recommendations = (Array.isArray(ai.recommendations) ? ai.recommendations : [])
    .map((r) => clip(`［${["高", "中", "低"].includes(r?.priority) ? r.priority : "中"}］${plain(r?.title)}`, 200)).filter((s) => s.length > 3).slice(0, 3);
  return {
    title: clip(report.title, 120),
    sender_label: clip(sender, 80),
    card: { subtitle: clip(`${report.storeName} · ${report.from}〜${report.to}`, 120), fields: fields.slice(0, 10), highlights, recommendations },
  };
}

/** M-talk 側のファイル名規則（英数字と ._() - のみ）に合わせる。 */
export function shareFileName(report) {
  const store = String(report?.storeName ?? "").normalize("NFKC").replace(/[^A-Za-z0-9._() -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${store ? `${store} ` : ""}AI-report ${report?.from ?? ""}_${report?.to ?? ""}.pdf`.replace(/\s+/g, " ").trim();
}

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function publicShare(r) {
  return {
    id: r.id, reportId: r.report_id, reportTitle: r.report_title, recipientId: r.recipient_user_id, recipientName: r.recipient_name,
    status: r.status, error: r.status === "failed" ? r.error ?? null : null, createdAt: r.created_at, sentAt: r.sent_at ?? null,
  };
}
