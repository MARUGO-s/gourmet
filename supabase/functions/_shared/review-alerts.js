// 口コミ通知（新着口コミ・総合点の変化 → M-talk の店舗Bot が参加しているグループのルーム）。Node/Deno 共通の純粋ロジック＋送信の手順。
// 検出は DB トリガー（migration 017）が review_alert_events に1回だけ記録する。ここでは記録を確保（claim）して
// 店舗ごとに1通へまとめ、その店舗の M-talk 店舗Bot（設定: 自動＝店舗名で判定／指定／送らない、migration 018）として
// line_report mtalk-external-post POST /alert で送る。Bot が決まらない店舗は送らない（skipped「店舗Botが未設定」）。
// 二重送信の防止: ① events の dedupe_key（口コミ・変化ごとに1行）② deliveries の (batch_id, Bot) ③ M-talk 側の
// chat_alert_dispatches（ルームごと、dedupe_key = gourmet-alert:<batch_id>）。止まった送信は同じ batch_id でやり直すので、送信済みのルームには M-talk が二度投稿しない。
import { SOURCES } from "./sources.js";

export const ALERT_PATH = "/alert";
export const APP_URL = "https://marugo-s.github.io/gourmet/";
export const STORE_BOTS_PATH = "/store-bots";
export const ALERT_LIMITS = { reviewsPerMessage: 10, textMax: 1000, titleMax: 100, claim: 50, maxAttempts: 5, rooms: 20, timeoutMs: 20_000 };
export const BOT_MODES = ["auto", "manual", "none"];
export const NO_BOT_REASON = "M-talkの店舗Botが未設定";
export const ALERT_STATUS_LABELS = { pending: "送信待ち", sending: "送信中", sent: "送信済み", skipped: "送らない", baseline: "基準（送らない）", failed: "失敗" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const siteName = (id) => SOURCES.find((s) => s.id === id)?.name ?? id;
export const clipText = (value, max, { multiline = false } = {}) => {
  let s = String(value ?? "").normalize("NFC").replace(CONTROL, "");
  s = multiline ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  s = s.trim();
  return [...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s;
};
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const fixed2 = (v) => (num(v) == null ? null : num(v).toFixed(2));
// 口コミの評価: 3.6 / 4.0 は小数1桁、3.55 は2桁
export const ratingText = (v) => (num(v) == null ? null : Number.isInteger(Math.round(num(v) * 100) / 10) ? num(v).toFixed(1) : num(v).toFixed(2));

// ---------- 店舗Bot の判定（店舗名 ↔ M-talk の店舗Bot の名前・店舗キー） ----------
// 全角/半角・大文字/小文字・空白・記号・末尾の「店」「bot」を無視し、よく使うカタカナ⇔英字の読みを揃えて比べる。
// 完全一致が1つならそれ、無ければ（5文字以上の）部分一致が1つならそれ。複数に当たるときは決めない（画面で選ぶ）。
const NAME_ALIASES = [
  ["マルゴ", "marugo"], ["エス", "s"], ["セカンド", "second"], ["オット", "otto"], ["グランデ", "grande"], ["丸の内", "marunouchi"],
  ["四谷", "yotsuya"], ["新橋", "shinbashi"], ["バル", "bar"], ["ぺロタ", "pelota"], ["ペロタ", "pelota"], ["サンナナイチ", "371"],
  ["ソバージュ", "sobaju"], ["ヴィオレット", "violet"], ["ミタン", "mitan"], ["クラウディア", "claudia"], ["ビストロ", "bistro"],
  ["カヴァカヴァ", "cavacava"], ["カバカバ", "cavacava"], ["サヴァサヴァ", "cavacava"], ["エリックス", "erics"], ["ブリッコラ", "briccola"],
];
export const normalizeStoreName = (value) => String(value ?? "").normalize("NFKC").toLowerCase()
  .replace(/[\s\u3000]*bot$/i, "").replace(/[\s\u3000・･\-‐―ー_'’`.,、。&()「」!?/]/g, "").replace(/店$/, "");
export function storeNameVariants(value) {
  const out = new Set([normalizeStoreName(value)]);
  let s = String(value ?? "").normalize("NFKC");
  for (const [kana, latin] of NAME_ALIASES) s = s.split(kana).join(latin);
  const latin = normalizeStoreName(s);
  out.add(latin);
  if (/2$/.test(latin)) out.add(latin.replace(/2$/, "second")); // MARUGO2 ⇔ マルゴ セカンド
  out.delete("");
  return out;
}
/** 店舗名に合う M-talk の店舗Bot（{ bot, how: "exact" | "partial" }）。決められなければ null。 */
export function matchStoreBot(storeName, bots) {
  const mine = [...storeNameVariants(storeName)];
  if (!mine.length || !Array.isArray(bots)) return null;
  const all = bots.map((b) => ({ b, v: [...new Set([...storeNameVariants(b.username), ...storeNameVariants(b.storeKey ?? b.store_key)])] }));
  const exact = all.filter(({ v }) => mine.some((x) => v.includes(x)));
  if (exact.length) return exact.length === 1 ? { bot: exact[0].b, how: "exact" } : null;
  const partial = all.filter(({ v }) => mine.some((x) => v.some((y) => { const [a, b] = x.length < y.length ? [x, y] : [y, x]; return a.length >= 5 && b.includes(a); })));
  return partial.length === 1 ? { bot: partial[0].b, how: "partial" } : null;
}

// ---------- 設定 ----------
/** 画面からの保存内容を検証する（店舗は本人の店舗に限る）。個人宛て（recipients）は触らない（互換のため残す）。 */
export function validateAlertSettingsInput(raw, storeIds) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("設定の形式が不正です");
  const storeId = String(raw.storeId ?? "").toLowerCase();
  if (!UUID.test(storeId) || !storeIds.includes(storeId)) throw new Error("店舗が見つかりません。店舗を選び直してください");
  for (const k of ["newReviews", "scoreChanges"]) if (typeof raw[k] !== "boolean") throw new Error(`${k} は true / false で指定してください`);
  const bot = raw.bot && typeof raw.bot === "object" ? raw.bot : { mode: "auto" };
  if (!BOT_MODES.includes(bot.mode)) throw new Error("店舗Botの指定が不正です");
  let botId = null, botName = null;
  if (bot.mode === "manual") {
    botId = String(bot.id ?? "").toLowerCase();
    if (!UUID.test(botId)) throw new Error("店舗Botを選んでください");
    botName = clipText(bot.name, 100) || null;
  }
  let roomIds = null;
  if (raw.roomIds != null) {
    if (!Array.isArray(raw.roomIds) || raw.roomIds.length > ALERT_LIMITS.rooms) throw new Error(`ルームは${ALERT_LIMITS.rooms}件までです`);
    if (raw.roomIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("ルームの指定が不正です");
    roomIds = [...new Set(raw.roomIds)];
    if (!roomIds.length) roomIds = null; // 空＝参加している全グループ
  }
  if (bot.mode === "auto" && roomIds) throw new Error("ルームを選ぶ場合は店舗Botを指定してください");
  return { store_id: storeId, new_reviews: raw.newReviews, score_changes: raw.scoreChanges, mtalk_bot_mode: bot.mode, mtalk_bot_id: botId, mtalk_bot_name: botName, mtalk_room_ids: roomIds };
}
/** 保存済みの行（無ければ既定: 両方オン・店舗Botは自動）。 */
export function resolveAlertSettings(row) {
  if (!row) return { newReviews: true, scoreChanges: true, botMode: "auto", botId: null, botName: null, roomIds: null, isDefault: true };
  const mode = BOT_MODES.includes(row.mtalk_bot_mode) ? row.mtalk_bot_mode : "auto";
  const botId = mode === "manual" && UUID.test(String(row.mtalk_bot_id ?? "")) ? String(row.mtalk_bot_id).toLowerCase() : null;
  const roomIds = Array.isArray(row.mtalk_room_ids) && row.mtalk_room_ids.length ? row.mtalk_room_ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : null;
  return { newReviews: row.new_reviews !== false, scoreChanges: row.score_changes !== false, botMode: botId || mode !== "manual" ? mode : "none", botId, botName: row.mtalk_bot_name ?? null, roomIds: botId ? roomIds : null, isDefault: false };
}
/** 送る Bot（{ id, name, how }）。自動は店舗名で判定（bots が読めないときは null＝判定できない）。 */
export function effectiveBot(settings, storeName, bots) {
  if (settings.botMode === "none") return null;
  if (settings.botMode === "manual") {
    const live = Array.isArray(bots) ? bots.find((b) => b.id === settings.botId) : null;
    return settings.botId ? { id: settings.botId, name: live?.username ?? settings.botName ?? "店舗Bot", how: "manual" } : null;
  }
  const m = matchStoreBot(storeName, bots);
  return m ? { id: m.bot.id, name: m.bot.username, how: m.how } : null;
}
/** @param {any[]} stores @param {any[]} rows @param {any[] | null} [bots] */
export function publicAlertSettings(stores, rows, bots = null) {
  const byStore = new Map((rows ?? []).map((r) => [r.store_id, r]));
  return stores.map((s) => {
    const settings = resolveAlertSettings(byStore.get(s.id) ?? null);
    const bot = bots ? effectiveBot(settings, s.name, bots) : settings.botMode === "manual" ? effectiveBot(settings, s.name, null) : null;
    return { storeId: s.id, storeName: s.name, ...settings, bot, updatedAt: byStore.get(s.id)?.updated_at ?? null };
  });
}
/** M-talk の /store-bots の応答 → 画面・判定用（Bot と、参加しているグループのルーム）。 */
export function normalizeStoreBots(data) {
  const list = Array.isArray(data?.bots) ? data.bots : [];
  return list.filter((b) => UUID.test(String(b?.id ?? "")) && String(b?.username ?? "").trim()).map((b) => ({
    id: String(b.id).toLowerCase(), username: clipText(b.username, 100), storeKey: clipText(b.store_key, 60),
    rooms: (Array.isArray(b.rooms) ? b.rooms : []).filter((r) => Number.isSafeInteger(r?.id) && r.id > 0)
      .map((r) => ({ id: r.id, name: clipText(r.name, 100) || `ルーム${r.id}`, isStoreRoom: r.is_store_room === true, members: Number.isSafeInteger(r.members) ? r.members : null })),
  }));
}

// ---------- 通知の内容 ----------
/** 口コミへのリンク（食べログ: 公開店舗ページ＋dtlrvwlst/B…/、一休: 店舗管理画面の口コミ一覧）。分からなければ null。 */
export function reviewLink(event, { publicUrl = null } = {}) {
  const p = event?.payload ?? {};
  if (event?.source === "tabelog") {
    const group = String(p.group_id ?? p.external_id ?? "").match(/^B\d+/)?.[0];
    return publicUrl && group ? `${publicUrl}dtlrvwlst/${group}/` : publicUrl ?? null;
  }
  if (event?.source === "ikyu" && /^\d{6}$/.test(String(event.store_key))) return `https://restaurant.ikyu.com/rsOwner/v2/${event.store_key}/legacy?path=/scriptO/rsOwnImpressions.asp`;
  return null;
}
const reviewSortKey = (e) => String(e.payload?.review_date ?? (e.payload?.visit_month ? `${e.payload.visit_month}-00` : ""));

/**
 * 1店舗ぶんのイベント → mtalk-external-post POST /alert の本文（送信先・dedupe_key は送信時に付ける）。
 * 口コミは新しい順に10件まで、残りは「ほか N件」。総合点の変化は常に全部（サイトごと）。
 */
export function buildAlertMessage({ storeName, events, publicUrls = {} }) {
  const score = events.filter((e) => e.kind === "score_change").sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const reviews = events.filter((e) => e.kind === "new_review").sort((a, b) => reviewSortKey(b).localeCompare(reviewSortKey(a)));
  const shown = reviews.slice(0, ALERT_LIMITS.reviewsPerMessage);
  const url = (e) => publicUrls[`${e.source}/${e.store_key}`] ?? null;
  const scoreChanges = score.map((e) => {
    const from = num(e.payload?.from), to = num(e.payload?.to);
    const diff = from != null && to != null ? Math.round((to - from) * 100) / 100 : null;
    return {
      site: siteName(e.source), from: fixed2(from), to: fixed2(to), diff: diff == null ? null : `${diff > 0 ? "+" : ""}${diff.toFixed(2)}`,
      date: e.payload?.date ?? null, review_count_from: num(e.payload?.review_count_from), review_count_to: num(e.payload?.review_count_to),
      url: e.source === "tabelog" ? url(e) : null,
    };
  });
  const items = shown.map((e) => {
    const p = e.payload ?? {};
    const text = clipText(p.text, ALERT_LIMITS.textMax, { multiline: true });
    const visit = p.visit_date ? String(p.visit_date).slice(0, 10) : p.visit_month ?? null;
    return {
      site: siteName(e.source), rating: ratingText(p.rating),
      posted_date: p.review_date ? String(p.review_date).slice(0, 10) : null, visit, title: clipText(p.title, ALERT_LIMITS.titleMax), text,
      text_note: !text ? "本文は取り込まれていません（評価だけ）" : p.text_complete === false || [...String(p.text ?? "")].length > ALERT_LIMITS.textMax ? "本文の一部です" : null,
      url: reviewLink(e, { publicUrl: url(e) }), url_label: e.source === "ikyu" ? "管理画面で見る" : "口コミを見る",
    };
  });
  return {
    store_name: clipText(storeName, 100) || "（店舗未設定）",
    score_changes: scoreChanges, reviews: items, more_count: reviews.length - shown.length, app_url: APP_URL,
  };
}
/** 通知のあらまし（ログ・テスト用） */
export function describeAlert(message) {
  const parts = [];
  for (const s of message.score_changes) parts.push(`${s.site} 総合点 ${s.from} → ${s.to}`);
  const n = message.reviews.length + message.more_count;
  if (n) parts.push(`新着口コミ ${n}件`);
  return `${message.store_name}: ${parts.join(" / ")}`;
}

// ---------- 送信 ----------
const groupKey = (e, storeOf) => storeOf(e.source, e.store_key)?.id ?? `unassigned:${e.source}/${e.store_key}`;

/**
 * 確保した通知を送る。store は supabaseAlertStore（テストでは偽物）、send(botId, body) は M-talk への送信
 * （失敗時は status を持つ例外。404 は Bot・ルームが見つからない＝やり直さない）、listBots() は M-talk の店舗Bot一覧（自動判定用）。
 */
export async function dispatchReviewAlerts(store, { send, listBots = async () => [], configured = true, limit = ALERT_LIMITS.claim, newId = () => crypto.randomUUID() }) {
  const summary = { claimed: 0, sent: 0, skipped: 0, retry: 0, failed: 0, messages: [] };
  if (!configured) return { ...summary, notConfigured: true }; // 確保しない（設定されたら送る）
  const claimed = await store.claim(limit);
  summary.claimed = claimed.length;
  if (!claimed.length) return summary;
  const ctx = await store.context(claimed);
  // 止まった送信は同じ batch_id のまま、新しいものは店舗ごとに1つの batch_id
  const batches = new Map();
  const fresh = new Map();
  for (const e of claimed) {
    if (e.batch_id) { if (!batches.has(e.batch_id)) batches.set(e.batch_id, []); batches.get(e.batch_id).push(e); continue; }
    const k = groupKey(e, ctx.storeOf);
    if (!fresh.has(k)) fresh.set(k, []);
    fresh.get(k).push(e);
  }
  for (const list of fresh.values()) {
    const id = newId();
    await store.assignBatch(list.map((e) => e.id), id);
    batches.set(id, list.map((e) => ({ ...e, batch_id: id })));
  }
  let bots; // 自動判定が要るときだけ1回読む（読めなければ undefined → やり直し）
  const loadBots = async () => {
    if (bots === undefined) bots = await listBots().catch(() => null);
    return bots;
  };
  for (const [batchId, list] of batches) {
    const storeInfo = ctx.storeOf(list[0].source, list[0].store_key);
    const storeName = storeInfo?.name ?? ctx.sourceStoreName(list[0]);
    const settings = resolveAlertSettings(storeInfo ? ctx.settings.get(storeInfo.id) ?? null : null);
    const wanted = list.filter((e) => (e.kind === "new_review" ? settings.newReviews : settings.scoreChanges));
    const off = list.filter((e) => !wanted.includes(e));
    if (off.length) { await store.finish(off.map((e) => e.id), "skipped", "通知の設定がオフ"); summary.skipped += off.length; }
    if (!wanted.length) continue;
    const ids = wanted.map((e) => e.id);
    const known = settings.botMode === "auto" ? await loadBots() : null;
    if (settings.botMode === "auto" && !known) { await store.release(ids); summary.retry += ids.length; continue; } // M-talk に届かない
    const bot = effectiveBot(settings, storeName, known);
    if (!bot) { await store.finish(ids, "skipped", NO_BOT_REASON); summary.skipped += ids.length; continue; }
    const message = buildAlertMessage({ storeName, events: wanted, publicUrls: ctx.publicUrls });
    summary.messages.push(`${describeAlert(message)} → ${bot.name}`);
    if ((await store.sentRecipients(batchId)).includes(bot.id)) { await store.finish(ids, "sent"); summary.sent += ids.length; continue; }
    const base = { batch_id: batchId, store_id: storeInfo?.id ?? null, store_name: message.store_name, recipient_user_id: bot.id, recipient_name: bot.name, target: "bot",
      event_ids: ids, new_reviews: wanted.filter((e) => e.kind === "new_review").length, score_changes: wanted.filter((e) => e.kind === "score_change").length };
    try {
      const res = await send(bot.id, { ...message, bot_id: bot.id, ...(settings.roomIds ? { room_ids: settings.roomIds } : {}), dedupe_key: `gourmet-alert:${batchId}` });
      const rooms = (Array.isArray(res?.rooms) ? res.rooms : []).slice(0, 50).map((r) => ({ id: r.group_id ?? null, name: clipText(r.name, 100), message_id: r.message_id ?? null, deduplicated: !!r.deduplicated }));
      await store.recordDelivery({ ...base, status: "sent", error: null, rooms, mtalk_group_id: rooms[0]?.id ?? null, mtalk_message_id: rooms[0]?.message_id ?? null, deduplicated: !!res?.deduplicated });
      await store.finish(ids, "sent");
      summary.sent += ids.length;
    } catch (error) {
      const status = Number(error?.status ?? 0);
      await store.recordDelivery({ ...base, status: "failed", error: clipText(error?.message ?? "送信に失敗しました", 300), rooms: [], mtalk_group_id: null, mtalk_message_id: null, deduplicated: false });
      if (status === 404) { await store.finish(ids, "failed", clipText(error?.message ?? "店舗Botまたはルームが見つかりません", 300)); summary.failed += ids.length; }
      else if (Math.max(...wanted.map((e) => e.attempts ?? 1)) >= ALERT_LIMITS.maxAttempts) { await store.finish(ids, "failed", `${ALERT_LIMITS.maxAttempts}回送れませんでした`); summary.failed += ids.length; }
      else { await store.release(ids); summary.retry += ids.length; }
    }
  }
  return summary;
}

/** service_role の Supabase クライアントで dispatchReviewAlerts の store を作る（agent-api 用）。 */
export function supabaseAlertStore(admin, userId) {
  const check = ({ data, error }) => { if (error) throw error; return data; };
  const inIds = (q, ids) => q.eq("user_id", userId).in("id", ids);
  return {
    claim: async (limit) => check(await admin.rpc("claim_review_alert_events", { p_user: userId, p_limit: limit })) ?? [],
    context: async (events) => {
      const sources = [...new Set(events.map((e) => e.source))];
      const [sites, stores, settings, sourceStores] = await Promise.all([
        admin.from("store_sites").select("store_id,source,site_store_key").eq("user_id", userId).in("source", sources).then(check),
        admin.from("stores").select("id,name").eq("user_id", userId).then(check),
        admin.from("review_alert_settings").select("*").eq("user_id", userId).then(check),
        admin.from("source_stores").select("source,store_key,name,public_url").eq("user_id", userId).then(check),
      ]);
      const names = new Map(stores.map((s) => [s.id, s.name]));
      const siteMap = new Map(sites.map((s) => [`${s.source}/${s.site_store_key}`, s.store_id]));
      const ss = new Map(sourceStores.map((s) => [`${s.source}/${s.store_key}`, s]));
      return {
        storeOf: (source, key) => { const id = siteMap.get(`${source}/${key}`); return id && names.has(id) ? { id, name: names.get(id) } : null; },
        sourceStoreName: (e) => ss.get(`${e.source}/${e.store_key}`)?.name ?? `${siteName(e.source)} ${e.store_key || "（既定）"}`,
        settings: new Map(settings.map((r) => [r.store_id, r])),
        publicUrls: Object.fromEntries(sourceStores.filter((s) => s.public_url).map((s) => [`${s.source}/${s.store_key}`, s.public_url])),
      };
    },
    assignBatch: async (ids, batchId) => check(await inIds(admin.from("review_alert_events").update({ batch_id: batchId }), ids).is("batch_id", null)),
    sentRecipients: async (batchId) => (check(await admin.from("review_alert_deliveries").select("recipient_user_id").eq("user_id", userId).eq("batch_id", batchId).eq("status", "sent")) ?? []).map((r) => r.recipient_user_id),
    recordDelivery: async (row) => check(await admin.from("review_alert_deliveries").upsert({ ...row, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: "batch_id,recipient_user_id" })),
    finish: async (ids, status, reason = null) => check(await inIds(admin.from("review_alert_events").update({ status, reason, ...(status === "sent" ? { sent_at: new Date().toISOString() } : {}) }), ids).eq("status", "sending")),
    release: async (ids) => check(await inIds(admin.from("review_alert_events").update({ status: "pending" }), ids).eq("status", "sending")),
  };
}

// 画面の通知履歴（送信先ごとの記録）
export function publicDelivery(r) {
  return {
    id: r.id, batchId: r.batch_id, storeName: r.store_name, recipientId: r.recipient_user_id, recipientName: r.recipient_name, status: r.status,
    error: r.status === "failed" ? r.error ?? null : null, newReviews: r.new_reviews, scoreChanges: r.score_changes, deduplicated: !!r.deduplicated,
    target: r.target === "bot" ? "bot" : "user", rooms: (Array.isArray(r.rooms) ? r.rooms : []).map((x) => ({ id: x.id ?? null, name: x.name ?? null, deduplicated: !!x.deduplicated })),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export function publicAlertEvent(e) {
  const p = e.payload ?? {};
  return {
    id: e.id, kind: e.kind, source: e.source, storeKey: e.store_key, status: e.status, reason: e.reason ?? null, createdAt: e.created_at, sentAt: e.sent_at ?? null,
    summary: e.kind === "score_change" ? `総合点 ${fixed2(p.from)} → ${fixed2(p.to)}` : `★${p.rating ?? "—"} ${clipText(p.title || p.text, 40)}`,
  };
}
