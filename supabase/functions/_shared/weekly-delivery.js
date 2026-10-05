// 週報（食べログ・一休などの共通テンプレート）を M-talk の店舗Botのルームへ届ける。Node/Deno 共通の純粋ロジック＋送信の手順。
// 流れ: Grok Bot（月曜の作業）が scripts/weekly-deliver.mjs で週報のビュー → 共通テンプレート HTML（GitHub Pages に置く）とカードの要約（任意で PDF）を作り、
//   agent-api POST /weekly/deliver（X-Ingest-Token）へ渡す → ここで検証し、店舗Bot・ルームを決めて
//   line_report mtalk-external-post POST /store-post（GOURMET_MTALK_TOKEN + HMAC）へ送る。
// GOURMET_MTALK_TOKEN は gourmet の Edge Function の秘密情報だけにあり、Grok Bot は持たない。
// 店舗Bot の決め方は口コミ通知と同じ設定（review_alert_settings: 自動＝店舗名で判定／指定／送らない、ルーム）。
// ルームの既定: 設定でルームを選んでいればそのルーム、無ければ Bot の「店舗ルーム」（is_store_room）、それも無ければ Bot が参加している全グループ。
// 二重送信の防止: dedupe_key = gourmet-weekly:<店舗 UUID>:<作成日の週の月曜（日本時間）>。M-talk がルームごとにカード・（任意の）PDF を1回だけ投稿する。
// カードは件数・評価・PV などの集計だけ。お客様の個人情報らしき文字列（メールアドレス・電話番号）があれば送らない。
// 週報の本体は HTML（承認済み共通テンプレート）。M-talk には HTML を添付せず、許可ホスト marugo-s.github.io 上の Pages URL を「週報を開く」で開く。PDF は任意。
import { SOURCES } from "./sources.js";
import { NO_BOT_REASON, effectiveBot, resolveAlertSettings } from "./review-alerts.js";

export const STORE_POST_PATH = "/store-post";
export const WEEKLY_APP_URL = "https://marugo-s.github.io/gourmet/";
/** 週報 HTML の GitHub Pages ルート（Vite public/weekly → dist/weekly）。 */
export const WEEKLY_PAGES_BASE = "https://marugo-s.github.io/gourmet/weekly";
export const WEEKLY_LIMITS = {
  sections: 4, fields: 8, fieldLabel: 24, fieldValue: 120, items: 3, item: 200, rooms: 20,
  /** PDF（デコード後）。agent-api の本文 8MB に base64 で収まる大きさ。 */
  pdfMaxBytes: 5 * 1024 * 1024, fileName: 120, timeoutMs: 45_000,
};
export const WEEKLY_NOTE = "数値は各サイトの管理画面・公開ページから取得した値です（取れなかった項目は「未取得」）。お客様の氏名・連絡先は載せていません。";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const clip = (value, max) => {
  const s = String(value ?? "").normalize("NFC").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return [...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s;
};
// 週報の見出し（週報テンプレートの site.label と同じ短い名前。無ければ sources.js の名前）
const WEEKLY_SITE_LABELS = { tabelog: "食べログ", ikyu: "一休", hotpepper: "ホットペッパー" };
const siteName = (id) => WEEKLY_SITE_LABELS[id] ?? SOURCES.find((s) => s.id === id)?.name ?? null;

export class WeeklyDeliveryError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

// line_report の looksLikePersonalInfo と同じ判定（メールアドレス・日本の電話番号）
const PII_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PII_PHONE = /(?:^|[^\d])(?:0\d{1,4}[-‐‑–—−ー－\s]?\d{1,4}[-‐‑–—−ー－\s]?\d{3,4}|\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?:[^\d]|$)/;
export function looksLikePersonalInfo(text) {
  const s = String(text ?? "").normalize("NFKC");
  if (PII_EMAIL.test(s)) return true;
  const m = PII_PHONE.exec(s);
  if (!m) return false;
  const digits = m[0].replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 12;
}

/** 作成日（YYYY-MM-DD、日本時間）の週の月曜。 */
export function weekMonday(asOf) {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
/** 店舗×週で1つ（月曜の作業をやり直しても、同じ週に二重に届かない）。 */
export const weeklyDedupeKey = (storeId, asOf) => `gourmet-weekly:${String(storeId).toLowerCase()}:${weekMonday(asOf)}`;
const slash = (ymd) => ymd.replace(/-/g, "/");

/** M-talk 側のファイル名規則（英数字と ._() - のみ）に合わせる。 */
export function weeklyFileName(storeName, asOf) {
  const store = String(storeName ?? "").normalize("NFKC").replace(/[^A-Za-z0-9._() -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${store ? `${store} ` : ""}weekly ${asOf}.pdf`.replace(/\s+/g, " ").trim();
}

/**
 * 店舗×作成日の週報 HTML（Pages）の URL。
 * 実体は `public/weekly/<storeId>/<asOf>/index.html`（＋サイト別 HTML）。カードの「週報を開く」がこれを開く。
 */
export function weeklyHtmlUrl(storeId, asOf) {
  const id = String(storeId ?? "").toLowerCase();
  if (!UUID.test(id)) throw new WeeklyDeliveryError("storeId が不正です");
  if (!DAY.test(String(asOf ?? ""))) throw new WeeklyDeliveryError("asOf は YYYY-MM-DD で指定してください");
  return `${WEEKLY_PAGES_BASE}/${id}/${asOf}/`;
}

/** Pages 上の週報パス（リポジトリの public/ からの相対）。 */
export function weeklyHtmlRepoPath(storeId, asOf) {
  const id = String(storeId ?? "").toLowerCase();
  if (!UUID.test(id)) throw new WeeklyDeliveryError("storeId が不正です");
  if (!DAY.test(String(asOf ?? ""))) throw new WeeklyDeliveryError("asOf は YYYY-MM-DD で指定してください");
  return `weekly/${id}/${asOf}`;
}

function pdfBase64(value) {
  const b64 = String(value ?? "").replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new WeeklyDeliveryError("PDFの形式が不正です");
  if (Math.floor((b64.length * 3) / 4) > WEEKLY_LIMITS.pdfMaxBytes + 3) throw new WeeklyDeliveryError("PDFが大きすぎます（5MBまで）", 413);
  let head = "";
  try { head = atob(b64.slice(0, 12)); } catch { throw new WeeklyDeliveryError("PDFの形式が不正です"); }
  if (!head.startsWith("%PDF-")) throw new WeeklyDeliveryError("PDFの形式が不正です（HTMLは添付できません。PDFにしてください）");
  return b64;
}

/**
 * agent-api POST /weekly/deliver の本文（Grok Bot から）。
 * { storeId? | site?: { source, storeKey }, asOf, sections: [{ source, fields: [{label,value}], items? }], pdf?: { base64, filename? }, roomIds?, dryRun? }
 */
export function validateWeeklyDeliverInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WeeklyDeliveryError("送信内容が不正です");
  const L = WEEKLY_LIMITS;
  let storeId = null, site = null;
  if (raw.storeId != null) {
    if (!UUID.test(String(raw.storeId))) throw new WeeklyDeliveryError("storeId が不正です");
    storeId = String(raw.storeId).toLowerCase();
  } else {
    const s = raw.site && typeof raw.site === "object" ? raw.site : {};
    if (!siteName(s.source) || typeof s.storeKey !== "string" || !/^[0-9A-Za-z_-]{1,40}$/.test(s.storeKey)) throw new WeeklyDeliveryError("storeId または site（source・storeKey）を指定してください");
    site = { source: s.source, storeKey: s.storeKey };
  }
  const asOf = String(raw.asOf ?? "");
  if (!DAY.test(asOf) || !Number.isFinite(Date.parse(`${asOf}T00:00:00Z`))) throw new WeeklyDeliveryError("asOf は YYYY-MM-DD で指定してください");
  if (!Array.isArray(raw.sections) || !raw.sections.length || raw.sections.length > L.sections) throw new WeeklyDeliveryError(`sections は1〜${L.sections}件で指定してください`);
  const seen = new Set();
  const sections = raw.sections.map((s) => {
    const label = siteName(s?.source);
    if (!label) throw new WeeklyDeliveryError("sections の source が不正です");
    if (seen.has(s.source)) throw new WeeklyDeliveryError("同じサイトの sections が重複しています");
    seen.add(s.source);
    const fields = (Array.isArray(s.fields) ? s.fields : []).slice(0, L.fields)
      .map((f) => ({ label: clip(f?.label, L.fieldLabel), value: clip(f?.value, L.fieldValue) })).filter((f) => f.label && f.value);
    const items = (Array.isArray(s.items) ? s.items : []).slice(0, L.items).map((x) => clip(String(x ?? "").replace(/\*\*/g, ""), L.item)).filter(Boolean);
    if (!fields.length) throw new WeeklyDeliveryError(`${label}のカードの項目がありません`);
    return { source: s.source, heading: label, fields, items };
  });
  const texts = sections.flatMap((s) => [...s.fields.flatMap((f) => [f.label, f.value]), ...s.items]);
  if (texts.some(looksLikePersonalInfo)) throw new WeeklyDeliveryError("カードに個人情報らしき文字列（メールアドレス・電話番号）が含まれています。件数・評価・PVなどの集計だけにしてください");
  let pdf = null;
  if (raw.pdf != null) {
    if (typeof raw.pdf !== "object") throw new WeeklyDeliveryError("pdf の形式が不正です");
    pdf = { base64: pdfBase64(raw.pdf.base64), filename: raw.pdf.filename == null ? null : clip(raw.pdf.filename, L.fileName) };
  }
  let roomIds = null;
  if (raw.roomIds != null) {
    if (!Array.isArray(raw.roomIds) || !raw.roomIds.length || raw.roomIds.length > L.rooms || raw.roomIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new WeeklyDeliveryError(`roomIds は1〜${L.rooms}件のルームIDで指定してください`);
    roomIds = [...new Set(raw.roomIds)];
  }
  if (raw.dryRun != null && typeof raw.dryRun !== "boolean") throw new WeeklyDeliveryError("dryRun は true / false で指定してください");
  return { storeId, site, asOf, sections, pdf, roomIds, dryRun: raw.dryRun === true };
}

/** 送るルーム: 指定 → 設定のルーム → Bot の店舗ルーム → null（＝M-talk が Bot の参加している全グループへ）。 */
export function weeklyRoomIds({ requested = null, settings, bot, bots }) {
  if (requested?.length) return requested;
  if (settings?.roomIds?.length) return settings.roomIds;
  const live = Array.isArray(bots) ? bots.find((b) => b.id === bot?.id) : null;
  const storeRooms = (live?.rooms ?? []).filter((r) => r.isStoreRoom).map((r) => r.id);
  return storeRooms.length ? storeRooms.slice(0, WEEKLY_LIMITS.rooms) : null;
}

/** mtalk-external-post POST /store-post の本文。 */
export function buildWeeklyStorePost({ storeId, storeName, asOf, sections, pdf, botId, roomIds, dryRun }) {
  const name = clip(storeName, 100) || "（店舗未設定）";
  const labels = sections.map((s) => s.heading).join("・");
  return {
    bot_id: botId,
    ...(roomIds?.length ? { room_ids: roomIds } : {}),
    dedupe_key: weeklyDedupeKey(storeId, asOf),
    type: "weekly_report",
    store_name: name,
    title: clip(`${name} 週報（${labels}）`, 120),
    subtitle: `${slash(asOf)} 作成（日本時間）`,
    sections: sections.map((s) => ({ heading: s.heading, fields: s.fields, items: s.items })),
    note: WEEKLY_NOTE,
    links: [{ label: "週報を開く", url: weeklyHtmlUrl(storeId, asOf) }],
    ...(pdf ? { files: [{ pdf_base64: pdf.base64, filename: pdf.filename || weeklyFileName(name, asOf) }] } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  };
}

/**
 * 1店舗の週報を送る。deps:
 *   findStore(input) → { id, name } | null（INGEST_USER_ID の店舗だけ）
 *   loadSettings(storeId) → review_alert_settings の行 | null
 *   listBots() → normalizeStoreBots の結果（M-talk GET /store-bots）
 *   send(payload) → M-talk POST /store-post の応答（失敗は status を持つ例外）
 */
export async function deliverWeeklyReport(input, { findStore, loadSettings, listBots, send, configured = true }) {
  if (!configured) throw new WeeklyDeliveryError("M-talk連携は未設定です（管理者がサーバーに接続情報を設定すると利用できます）", 503);
  const store = await findStore(input);
  if (!store) throw new WeeklyDeliveryError("店舗が見つかりません（storeId、またはアプリの店舗に紐づいたサイトの店舗キーを指定してください）", 404);
  const settings = resolveAlertSettings(await loadSettings(store.id));
  const dedupeKey = weeklyDedupeKey(store.id, input.asOf);
  const base = { store: { id: store.id, name: store.name }, asOf: input.asOf, week: weekMonday(input.asOf), dedupeKey, dryRun: input.dryRun };
  if (settings.botMode === "none") return { ok: false, ...base, skipped: "この店舗は M-talk の店舗Botへ「送らない」設定です（アプリの「口コミ通知」で変更できます）" };
  const bots = await listBots();
  const bot = effectiveBot(settings, store.name, bots);
  if (!bot) return { ok: false, ...base, skipped: `${NO_BOT_REASON}（アプリの「口コミ通知」で店舗Botを指定してください）` };
  const roomIds = weeklyRoomIds({ requested: input.roomIds, settings, bot, bots });
  const payload = buildWeeklyStorePost({ storeId: store.id, storeName: store.name, asOf: input.asOf, sections: input.sections, pdf: input.pdf, botId: bot.id, roomIds, dryRun: input.dryRun });
  const res = await send(payload);
  const rooms = (Array.isArray(res?.rooms) ? res.rooms : []).slice(0, 50).map((r) => ({
    id: r.group_id ?? null, name: clip(r.name, 100), isStoreRoom: r.is_store_room ?? undefined,
    ...(input.dryRun ? { alreadySent: !!r.already_sent } : { cardMessageId: r.card_message_id ?? null, fileMessageIds: Array.isArray(r.file_message_ids) ? r.file_message_ids : [], deduplicated: !!r.deduplicated }),
  }));
  return {
    ok: true, ...base, bot: { id: bot.id, name: res?.bot_name ? clip(res.bot_name, 100) : bot.name, how: bot.how }, roomIds, rooms,
    html: { url: weeklyHtmlUrl(store.id, input.asOf) },
    pdf: payload.files ? { filename: payload.files[0].filename } : null,
    ...(input.dryRun ? { preview: clip(res?.text, 500) } : { deduplicated: !!res?.deduplicated }),
  };
}
