import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ALERT_LIMITS, NO_BOT_REASON, buildAlertMessage, describeAlert, dispatchReviewAlerts, matchStoreBot, normalizeStoreBots, publicAlertSettings, ratingText,
  resolveAlertSettings, reviewLink, validateAlertSettingsInput, publicAlertEvent,
} from "../../supabase/functions/_shared/review-alerts.js";
import { mtalkRequest } from "../../supabase/functions/_shared/mtalk-share.js";
import { normalizeSourceIngest } from "../../supabase/functions/_shared/source-ingest.js";
import { normalizeIkyuIngest } from "../../supabase/functions/_shared/ikyu-data.js";

const STORE = "89831708-aeac-4d1d-a345-8b345579a27f";
const OTHER = "11111111-2222-4333-8444-555555555555";
const ME = "3186a986-547f-41c0-81c2-56f9427e123c";
const PUBLIC = "https://tabelog.com/tokyo/A1309/A130903/13245351/";
const migration = fs.readFileSync(new URL("../../supabase/migrations/017_review_alerts.sql", import.meta.url), "utf8");
const migration018 = fs.readFileSync(new URL("../../supabase/migrations/018_review_alerts_store_bots.sql", import.meta.url), "utf8");

// ---------- 店舗Bot の判定（実際の gourmet 24店舗 × M-talk 店舗Bot 22件） ----------
const BOTS = `barpelota|バルぺロタ
bistrocavacava|Bistro CAVACAVA
briccola|トラットリア ブリッコラ
claudia2|クラウディア2
donaiya|元祖どないや 新宿三丁目店
erics|エリックスバイエリックトロション
marugo|MARUGO
marugoD|マルゴ D
marugogrande|マルゴ グランデ
marugomarunouchi|マルゴ丸の内
marugootto|マルゴ オット
marugoS|マルゴエス
marugosecond|マルゴ セカンド
marugoshinbashi|マルゴ 新橋
marugoyotsuya|マルゴ 四谷
mitan|ミタン
sannanaichi|サンナナイチ バル
sauvage|ソバージュ
shenlong|シェンロン&クラウディア
sushikoruri|鮨こるり
violette|ヴィオレット
yakinikumarugo|焼肉マルゴ`.split("\n").map((l, i) => {
  const [storeKey, username] = l.split("|");
  return { id: `285666af-5fbb-43a9-88e2-${String(i).padStart(12, "0")}`, username, storeKey, rooms: [{ id: 100 + i, name: username, isStoreRoom: true, members: 5 }] };
});
const CAVA_BOT = BOTS.find((b) => b.storeKey === "bistrocavacava");
const GOURMET_STORES = ["MARUGO-D", "MARUGO-OTTO", "元祖どないや新宿三丁目", "鮨こるり", "MARUGO", "MARUGO2", "MARUGO GRANDE", "MARUGO MARUNOUCHI", "マルゴ新橋", "マルゴS",
  "MARUGO YOTSUYA", "371BAR", "三三五五", "BAR PELOTA", "Claudia2", "BISTRO CAVACAVA", "eric'S", "MITAN", "焼肉マルゴ", "SOBA-JU", "Bar Violet", "X&C", "トラットリア ブリッコラ", "BLU NERO"];

test("store bot matching: 21 of the 24 gourmet stores match one M-talk store bot by name", () => {
  const got = Object.fromEntries(GOURMET_STORES.map((n) => [n, matchStoreBot(n, BOTS)?.bot.storeKey ?? null]));
  assert.deepEqual(got, {
    "MARUGO-D": "marugoD", "MARUGO-OTTO": "marugootto", "元祖どないや新宿三丁目": "donaiya", "鮨こるり": "sushikoruri", MARUGO: "marugo", MARUGO2: "marugosecond",
    "MARUGO GRANDE": "marugogrande", "MARUGO MARUNOUCHI": "marugomarunouchi", "マルゴ新橋": "marugoshinbashi", "マルゴS": "marugoS", "MARUGO YOTSUYA": "marugoyotsuya",
    "371BAR": "sannanaichi", "三三五五": null, "BAR PELOTA": "barpelota", Claudia2: "claudia2", "BISTRO CAVACAVA": "bistrocavacava", "eric'S": "erics", MITAN: "mitan",
    "焼肉マルゴ": "yakinikumarugo", "SOBA-JU": "sauvage", "Bar Violet": "violette", "X&C": null, "トラットリア ブリッコラ": "briccola", "BLU NERO": null,
  });
  assert.equal(Object.values(got).filter(Boolean).length, 21);
  // 全角・半角・空白・記号・「bot」・カタカナ読みの違いは同じ店
  for (const n of ["ＢＩＳＴＲＯ　ＣＡＶＡＣＡＶＡ", "bistro cava cava", "Bistro CAVACAVA bot", "ビストロ カヴァカヴァ", "BISTRO CAVA CAVA", "サヴァサヴァ"]) {
    assert.equal(matchStoreBot(n, BOTS)?.bot.id, CAVA_BOT.id, n);
  }
  assert.equal(matchStoreBot("BISTRO CAVACAVA", [...BOTS, { ...CAVA_BOT, id: "11111111-1111-4111-8111-111111111111" }]), null, "2つに当たるときは決めない");
  assert.equal(matchStoreBot("", BOTS), null);
  assert.equal(matchStoreBot("MARUGO", null), null);
});

// ---------- 設定 ----------
test("alert settings: own stores only, bot auto/manual/none, rooms only with a chosen bot", () => {
  const BOT = CAVA_BOT.id;
  assert.deepEqual(validateAlertSettingsInput({ storeId: STORE.toUpperCase(), newReviews: true, scoreChanges: false, bot: { mode: "auto" } }, [STORE]),
    { store_id: STORE, new_reviews: true, score_changes: false, mtalk_bot_mode: "auto", mtalk_bot_id: null, mtalk_bot_name: null, mtalk_room_ids: null });
  assert.deepEqual(validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "manual", id: BOT.toUpperCase(), name: " Bistro\n CAVACAVA " }, roomIds: [5, 30, 5] }, [STORE]),
    { store_id: STORE, new_reviews: true, score_changes: true, mtalk_bot_mode: "manual", mtalk_bot_id: BOT, mtalk_bot_name: "Bistro CAVACAVA", mtalk_room_ids: [5, 30] });
  assert.equal(validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "manual", id: BOT }, roomIds: [] }, [STORE]).mtalk_room_ids, null, "空＝全グループ");
  assert.equal(validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "none" } }, [STORE]).mtalk_bot_mode, "none");
  assert.equal(validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true }, [STORE]).mtalk_bot_mode, "auto", "省略は自動");
  assert.ok(!("recipients" in validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, recipients: [{ id: ME }] }, [STORE])), "個人宛ては保存しない（互換のため列は残す）");
  assert.throws(() => validateAlertSettingsInput({ storeId: OTHER, newReviews: true, scoreChanges: true }, [STORE]), /店舗/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: "yes", scoreChanges: true }, [STORE]), /true/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "x" } }, [STORE]), /店舗Bot/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "manual", id: "x" } }, [STORE]), /選んで/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "auto" }, roomIds: [5] }, [STORE]), /指定/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "manual", id: BOT }, roomIds: [1.5] }, [STORE]), /ルーム/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, bot: { mode: "manual", id: BOT }, roomIds: Array.from({ length: 21 }, (_, i) => i + 1) }, [STORE]), /20件/);
});

test("alert settings default to both on with the store bot matched by name; old recipient rows still read", () => {
  assert.deepEqual(resolveAlertSettings(null), { newReviews: true, scoreChanges: true, botMode: "auto", botId: null, botName: null, roomIds: null, isDefault: true });
  const legacy = resolveAlertSettings({ new_reviews: true, score_changes: false, recipients: [{ id: ME, name: "i" }] });
  assert.deepEqual([legacy.botMode, legacy.scoreChanges], ["auto", false], "migration 018 以前の行（個人宛て）も自動判定で読む");
  const [cava, blu, manual, none] = publicAlertSettings(
    [{ id: STORE, name: "BISTRO CAVACAVA" }, { id: OTHER, name: "BLU NERO" }, { id: "a", name: "X&C" }, { id: "b", name: "MARUGO" }],
    [{ store_id: "a", mtalk_bot_mode: "manual", mtalk_bot_id: BOTS[18].id, mtalk_bot_name: "旧名", mtalk_room_ids: [118] }, { store_id: "b", mtalk_bot_mode: "none" }], BOTS);
  assert.deepEqual(cava.bot, { id: CAVA_BOT.id, name: "Bistro CAVACAVA", how: "exact" });
  assert.equal(blu.bot, null, "未設定");
  assert.deepEqual([manual.bot.name, manual.bot.how, manual.roomIds], ["シェンロン&クラウディア", "manual", [118]], "指定の Bot は今の名前で出す");
  assert.equal(none.bot, null);
  const offline = publicAlertSettings([{ id: "a", name: "X&C" }, { id: STORE, name: "BISTRO CAVACAVA" }], [{ store_id: "a", mtalk_bot_mode: "manual", mtalk_bot_id: BOTS[18].id, mtalk_bot_name: "旧名" }], null);
  assert.deepEqual([offline[0].bot?.name, offline[1].bot], ["旧名", null], "Bot 一覧が読めないとき: 指定は保存名、自動は判定できない");
});

test("store bot list from M-talk is sanitized", () => {
  const got = normalizeStoreBots({ bots: [{ id: CAVA_BOT.id.toUpperCase(), username: " Bistro CAVACAVA ", store_key: "bistrocavacava", rooms: [{ id: 5, name: "Bistro CAVACAVA", is_store_room: true, members: 6 }, { id: "x" }] }, { id: "bad", username: "x" }] });
  assert.deepEqual(got, [{ id: CAVA_BOT.id, username: "Bistro CAVACAVA", storeKey: "bistrocavacava", rooms: [{ id: 5, name: "Bistro CAVACAVA", isStoreRoom: true, members: 6 }] }]);
  assert.deepEqual(normalizeStoreBots(null), []);
});

// ---------- 通知の内容 ----------
const review = (n, over = {}) => ({
  id: `e${n}`, kind: "new_review", source: "tabelog", store_key: "13245351", attempts: 1, created_at: `2026-10-01T0${n % 10}:00:00Z`,
  payload: { external_id: `B${100 + n}:excerpt`, group_id: `B${100 + n}`, rating: 3.6, title: `タイトル${n}`, text: `本文${n}`, text_complete: true,
    review_date: `2026-09-${String(10 + n).padStart(2, "0")}`, visit_month: "2026-09" }, ...over,
});
const score = (from, to, over = {}) => ({ id: `s${from}${to}`, kind: "score_change", source: "tabelog", store_key: "13245351", attempts: 1, created_at: "2026-10-01T01:00:00Z",
  payload: { from, to, date: "2026-10-01", review_count_from: 49, review_count_to: 50 }, ...over });

test("rating text keeps one decimal for x.x and two for x.xx", () => {
  assert.deepEqual([3.6, 4, 3.55, "3.26", null, "x"].map(ratingText), ["3.6", "4.0", "3.55", "3.26", null, null]);
});

test("review links: Tabelog review page per B-group, Ikyu owner review list", () => {
  assert.equal(reviewLink(review(1), { publicUrl: PUBLIC }), `${PUBLIC}dtlrvwlst/B101/`);
  assert.equal(reviewLink(review(1)), null, "公開ページが分からなければリンクなし");
  assert.equal(reviewLink({ source: "tabelog", payload: { external_id: "x" } }, { publicUrl: PUBLIC }), PUBLIC);
  assert.equal(reviewLink({ source: "ikyu", store_key: "112789", payload: {} }), "https://restaurant.ikyu.com/rsOwner/v2/112789/legacy?path=/scriptO/rsOwnImpressions.asp");
  assert.equal(reviewLink({ source: "ikyu", store_key: "../x", payload: {} }), null);
});

test("message: score changes first, newest 10 reviews, rest as more_count, text notes", () => {
  const events = [score(3.26, 3.28), ...Array.from({ length: 12 }, (_, i) => review(i + 1))];
  events[3] = review(3, { payload: { ...review(3).payload, text: "", title: "" } });
  events[4] = review(4, { payload: { ...review(4).payload, text: "あ".repeat(1500) } });
  events[5] = review(5, { payload: { ...review(5).payload, text_complete: false } });
  const m = buildAlertMessage({ storeName: "BISTRO CAVA CAVA", events, publicUrls: { "tabelog/13245351": PUBLIC } });
  assert.deepEqual(m.score_changes, [{ site: "食べログ", from: "3.26", to: "3.28", diff: "+0.02", date: "2026-10-01", review_count_from: 49, review_count_to: 50, url: PUBLIC }]);
  assert.equal(m.reviews.length, 10);
  assert.equal(m.more_count, 2);
  assert.equal(m.reviews[0].posted_date, "2026-09-22", "新しい順");
  assert.equal(m.reviews[0].url, `${PUBLIC}dtlrvwlst/B112/`);
  assert.equal(m.reviews[0].rating, "3.6");
  const byTitle = (t) => m.reviews.find((r) => r.title === t);
  assert.equal(m.reviews.find((r) => r.posted_date === "2026-09-13").text_note, "本文は取り込まれていません（評価だけ）");
  assert.equal([...byTitle("タイトル4").text].length, ALERT_LIMITS.textMax);
  assert.equal(byTitle("タイトル4").text_note, "本文の一部です");
  assert.equal(byTitle("タイトル5").text_note, "本文の一部です");
  assert.equal(byTitle("タイトル6").text_note, null);
  assert.equal(describeAlert(m), "BISTRO CAVA CAVA: 食べログ 総合点 3.26 → 3.28 / 新着口コミ 12件");
  const down = buildAlertMessage({ storeName: "", events: [score(3.28, 3.2)] });
  assert.equal(down.score_changes[0].diff, "-0.08");
  assert.equal(down.store_name, "（店舗未設定）");
  assert.equal(down.more_count, 0);
  assert.equal(publicAlertEvent({ id: "1", kind: "score_change", payload: { from: 3.26, to: 3.28 } }).summary, "総合点 3.26 → 3.28");
});

// ---------- 送信（偽の store で手順を確認） ----------
function fakeStore(events, { settings = new Map(), sites = { "tabelog/13245351": { id: STORE, name: "BISTRO CAVACAVA" } } } = {}) {
  const db = { events: events.map((e) => ({ status: "pending", batch_id: null, attempts: 0, ...e })), deliveries: [] };
  return {
    db,
    claim: async (limit) => {
      const got = db.events.filter((e) => e.status === "pending").slice(0, limit);
      for (const e of got) { e.status = "sending"; e.attempts++; }
      return got.map((e) => ({ ...e }));
    },
    context: async () => ({
      storeOf: (s, k) => sites[`${s}/${k}`] ?? null, sourceStoreName: (e) => `未割り当て ${e.store_key}`, settings, publicUrls: { "tabelog/13245351": PUBLIC },
    }),
    assignBatch: async (ids, batchId) => { for (const e of db.events) if (ids.includes(e.id) && !e.batch_id) e.batch_id = batchId; },
    sentRecipients: async (batchId) => db.deliveries.filter((d) => d.batch_id === batchId && d.status === "sent").map((d) => d.recipient_user_id),
    recordDelivery: async (row) => {
      const i = db.deliveries.findIndex((d) => d.batch_id === row.batch_id && d.recipient_user_id === row.recipient_user_id);
      if (i >= 0) db.deliveries[i] = row; else db.deliveries.push(row);
    },
    finish: async (ids, status, reason = null) => { for (const e of db.events) if (ids.includes(e.id) && e.status === "sending") Object.assign(e, { status, reason }); },
    release: async (ids) => { for (const e of db.events) if (ids.includes(e.id) && e.status === "sending") e.status = "pending"; },
  };
}
const ids = () => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; };
const listBots = async () => BOTS;
const okRooms = (rooms = [{ group_id: 5, name: "Bistro CAVACAVA", message_id: 70 }, { group_id: 30, name: "BistroCAVACAVA", message_id: 71 }]) => ({ ok: true, bot_id: CAVA_BOT.id, rooms, deduplicated: false });

test("dispatch: one message per store as the matched store bot to its rooms, dedupe key per batch, nothing sent twice", async () => {
  const store = fakeStore([review(1), review(2), score(3.26, 3.28)]);
  const sent = [];
  const send = async (to, body) => { sent.push({ to, body }); return okRooms(); };
  const r = await dispatchReviewAlerts(store, { send, listBots, newId: ids() });
  assert.deepEqual([r.claimed, r.sent, r.retry, r.failed], [3, 3, 0, 0]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, CAVA_BOT.id);
  assert.equal(sent[0].body.bot_id, CAVA_BOT.id);
  assert.ok(!("room_ids" in sent[0].body), "未選択＝Bot が参加している全グループ（M-talk 側で決める）");
  assert.ok(!("recipient_user_id" in sent[0].body), "個人宛てには送らない");
  assert.equal(sent[0].body.dedupe_key, "gourmet-alert:00000000-0000-4000-8000-000000000001");
  assert.deepEqual([sent[0].body.reviews.length, sent[0].body.score_changes.length], [2, 1]);
  const [d] = store.db.deliveries;
  assert.deepEqual([d.status, d.target, d.recipient_name, d.new_reviews, d.score_changes, d.mtalk_group_id, d.mtalk_message_id], ["sent", "bot", "Bistro CAVACAVA", 2, 1, 5, 70]);
  assert.deepEqual(d.rooms.map((x) => x.id), [5, 30]);
  assert.match(r.messages[0], /→ Bistro CAVACAVA$/);
  assert.ok(store.db.events.every((e) => e.status === "sent"));
  const again = await dispatchReviewAlerts(store, { send, listBots, newId: ids() });
  assert.equal(again.claimed, 0);
  assert.equal(sent.length, 1);
});

test("dispatch: chosen bot and rooms are sent as is (no bot list needed)", async () => {
  const settings = new Map([[STORE, { store_id: STORE, new_reviews: true, score_changes: true, mtalk_bot_mode: "manual", mtalk_bot_id: CAVA_BOT.id, mtalk_bot_name: "Bistro CAVACAVA", mtalk_room_ids: [5] }]]);
  const store = fakeStore([review(1)], { settings });
  const sent = [];
  await dispatchReviewAlerts(store, { send: async (to, b) => { sent.push(b); return okRooms([{ group_id: 5, name: "Bistro CAVACAVA", message_id: 1 }]); }, listBots: async () => assert.fail("読まない"), newId: ids() });
  assert.deepEqual([sent[0].bot_id, sent[0].room_ids], [CAVA_BOT.id, [5]]);
});

test("dispatch: no store bot (unmatched / none) → skipped 未設定, never sent; settings off → skipped", async () => {
  const blu = fakeStore([review(1)], { sites: { "tabelog/13245351": { id: STORE, name: "BLU NERO" } } });
  const r = await dispatchReviewAlerts(blu, { send: async () => assert.fail("送らない"), listBots, newId: ids() });
  assert.equal(r.skipped, 1);
  assert.deepEqual([blu.db.events[0].status, blu.db.events[0].reason], ["skipped", NO_BOT_REASON]);
  const none = fakeStore([review(1)], { settings: new Map([[STORE, { store_id: STORE, new_reviews: true, score_changes: true, mtalk_bot_mode: "none" }]]) });
  await dispatchReviewAlerts(none, { send: async () => assert.fail("送らない"), listBots, newId: ids() });
  assert.equal(none.db.events[0].reason, NO_BOT_REASON);
  const off = fakeStore([review(1), score(3.26, 3.28)], { settings: new Map([[STORE, { store_id: STORE, new_reviews: false, score_changes: true }]]) });
  const sent = [];
  const r2 = await dispatchReviewAlerts(off, { send: async (_t, b) => { sent.push(b); return okRooms(); }, listBots, newId: ids() });
  assert.deepEqual([r2.sent, r2.skipped, sent[0].reviews.length], [1, 1, 0]);
  assert.equal(off.db.events.find((e) => e.kind === "new_review").reason, "通知の設定がオフ");
});

test("dispatch: bot list unavailable → retry later (not skipped); M-talk not configured → nothing is claimed", async () => {
  const store = fakeStore([review(1)]);
  const r = await dispatchReviewAlerts(store, { send: async () => assert.fail("送らない"), listBots: async () => { throw new Error("down"); }, newId: ids() });
  assert.equal(r.retry, 1);
  assert.equal(store.db.events[0].status, "pending");
  const off = fakeStore([review(1)]);
  const r2 = await dispatchReviewAlerts(off, { configured: false, send: async () => assert.fail("送らない") });
  assert.equal(r2.notConfigured, true);
  assert.equal(off.db.events[0].status, "pending");
});

test("dispatch: temporary failure keeps the batch and dedupe key; 404 (bot/rooms gone) is permanent; 5 attempts → failed", async () => {
  const store = fakeStore([review(1)]);
  const keys = [];
  let down = true;
  const send = async (_to, body) => { keys.push(body.dedupe_key); if (down) throw Object.assign(new Error("M-talk に接続できませんでした"), { status: 502 }); return okRooms(); };
  const first = await dispatchReviewAlerts(store, { send, listBots, newId: ids() });
  assert.deepEqual([first.retry, first.sent], [1, 0]);
  assert.equal(store.db.events[0].status, "pending");
  assert.equal(store.db.deliveries[0].status, "failed");
  down = false;
  const second = await dispatchReviewAlerts(store, { send, listBots, newId: () => assert.fail("新しい batch は作らない") });
  assert.equal(second.sent, 1);
  assert.equal(new Set(keys).size, 1, "やり直しも同じ dedupe_key（M-talk 側で送信済みのルームには二度投稿しない）");
  assert.equal(store.db.deliveries[0].status, "sent");

  const gone = fakeStore([review(2)]);
  const r404 = await dispatchReviewAlerts(gone, { send: async () => { throw Object.assign(new Error("このBotが参加しているグループのルームがありません"), { status: 404 }); }, listBots, newId: ids() });
  assert.deepEqual([r404.failed, r404.retry], [1, 0]);
  assert.match(gone.db.events[0].reason, /ルームがありません/);

  const tired = fakeStore([review(3, { attempts: ALERT_LIMITS.maxAttempts - 1 })]);
  const rTired = await dispatchReviewAlerts(tired, { send: async () => { throw Object.assign(new Error("x"), { status: 500 }); }, listBots, newId: ids() });
  assert.equal(rTired.failed, 1);
  assert.match(tired.db.events[0].reason, /5回/);
});

test("dispatch: stale 'sending' events come back with their batch id; an already-sent batch is not sent again", async () => {
  const store = fakeStore([review(1, { batch_id: "b-old" }), review(2)]);
  store.db.deliveries.push({ batch_id: "b-old", recipient_user_id: CAVA_BOT.id, status: "sent" });
  const keys = [];
  const r = await dispatchReviewAlerts(store, { send: async (_to, b) => { keys.push(b.dedupe_key); return okRooms(); }, listBots, newId: () => "b-new" });
  assert.deepEqual(keys, ["gourmet-alert:b-new"]);
  assert.equal(r.sent, 2);
});

test("dispatch: unassigned site stores match the bot by the site's store name", async () => {
  const store = fakeStore([review(1, { store_key: "99999999" })]);
  const got = [];
  await dispatchReviewAlerts(store, { send: async (to) => { got.push(to); return okRooms(); }, listBots, newId: ids() });
  assert.deepEqual(got, [], "「未割り当て 99999999」に合う Bot は無い → 送らない");
  assert.equal(store.db.events[0].reason, NO_BOT_REASON);
});

test("M-talk /alert: missing recipient is permanent (404), missing route (not yet deployed) is retried (502)", async () => {
  const config = { url: "https://example.supabase.co/functions/v1/mtalk-external-post", token: "t".repeat(40), configured: true };
  const reply = (status, body) => async (url, init) => {
    assert.equal(url, `${config.url}/alert`);
    assert.match(init.headers["X-Mtalk-Signature"], /^v1=[0-9a-f]{64}$/);
    return new Response(JSON.stringify(body), { status });
  };
  await assert.rejects(mtalkRequest(config, "POST", "/alert", {}, { fetchImpl: reply(404, { error: "送信先の利用者が見つからないか、利用停止中です" }) }), (e) => e.status === 404);
  await assert.rejects(mtalkRequest(config, "POST", "/alert", {}, { fetchImpl: reply(404, { error: "not found" }) }), (e) => e.status === 502);
  assert.deepEqual(await mtalkRequest(config, "POST", "/alert", {}, { fetchImpl: reply(200, { ok: true, message_id: 1 }) }), { ok: true, message_id: 1 });
});

// ---------- マイグレーション ----------
test("migration 017: owner-only reads, claim only for service_role, triggers are after-insert/update", () => {
  assert.match(migration, /create trigger review_alert_new_source_review after insert on public\.source_reviews/);
  assert.match(migration, /create trigger review_alert_new_ikyu_review after insert on public\.ikyu_reviews/);
  assert.match(migration, /after update of rating on public\.source_stores[\s\S]*old\.rating is not null and new\.rating is not null/);
  assert.match(migration, /grant execute on function public\.claim_review_alert_events\(uuid,integer\) to service_role/);
  assert.match(migration, /revoke all on function %s from public, anon, authenticated/);
  assert.match(migration, /unique \(user_id, dedupe_key\)/);
  assert.doesNotMatch(migration, /for (insert|update|delete|all)\s+to authenticated/i, "画面からの書き込みは review-api（検証後）だけ");
});

test("migration 018: store bot columns, recipients kept for compatibility, deliveries record rooms", () => {
  assert.match(migration018, /add column if not exists mtalk_bot_mode text not null default 'auto'/);
  assert.match(migration018, /check \(mtalk_bot_mode in \('auto', 'manual', 'none'\)\)/);
  assert.match(migration018, /mtalk_bot_mode <> 'manual' or mtalk_bot_id is not null/);
  assert.match(migration018, /add column if not exists rooms jsonb/);
  assert.doesNotMatch(migration018, /drop column|delete from|update public\./i, "既存の行・列は変えない");
});

// ---------- 実際の Postgres での検出（Postgres 17 がある環境だけ） ----------
const PG = "/usr/lib/postgresql/17/bin";
const pgAvailable = fs.existsSync(`${PG}/initdb`) && process.getuid?.() !== 0;
const STUB = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema if not exists extensions;
create extension if not exists pgcrypto;`;

test("real Postgres: baseline on first ingest, then new reviews / score changes once each", { skip: pgAvailable ? false : "Postgres 17 がありません" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gourmet-alerts-pg-"));
  const port = String(56000 + Math.floor(Math.random() * 1000));
  const env = { ...process.env, PGHOST: dir, PGPORT: port, PGUSER: "postgres", PGDATABASE: "postgres" };
  const run = (file, args) => execFileSync(`${PG}/${file}`, args, { env, stdio: ["pipe", "pipe", "pipe"] }).toString();
  const psql = (sql) => execFileSync(`${PG}/psql`, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { env, input: sql }).toString().trim();
  run("initdb", ["-D", `${dir}/data`, "-U", "postgres", "-A", "trust"]);
  run("pg_ctl", ["-D", `${dir}/data`, "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-l", `${dir}/log`, "-w", "start"]);
  try {
    psql(STUB);
    const migrations = new URL("../../supabase/migrations/", import.meta.url).pathname;
    for (const f of fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) psql(fs.readFileSync(path.join(migrations, f), "utf8"));
    const USER = "114c1410-ebc0-433a-9d30-e0e2410dec13";
    psql(`insert into auth.users(id) values ('${USER}');`);
    const jst = (days) => new Date(Date.now() + 9 * 3600_000 - days * 86400_000).toISOString().slice(0, 10);
    const today = jst(0);
    const tabelog = (runId, rating, reviews, reviewCount) => normalizeSourceIngest({
      schemaVersion: 1, source: "tabelog", runId, agent: "grok-bot", capturedAt: new Date().toISOString(),
      stores: [{ storeKey: "13245351", name: "BISTRO CAVA CAVA", publicUrl: PUBLIC, summary: { rating, reviewCount }, reviews: { total: reviews.length, items: reviews } }],
    }, today);
    const rv = (externalId, postedAt, text = "おいしかった") => ({ externalId, postedAt, rating: 3.5, title: "良い店", text, textComplete: !externalId.endsWith(":excerpt") });
    const ingest = (n) => psql(`select public.ingest_source('${USER}', 'tabelog', $j$${JSON.stringify(n.run)}$j$::jsonb, $j$${JSON.stringify(n.stores)}$j$::jsonb);`);
    const events = () => JSON.parse(psql(`select coalesce(json_agg(json_build_object('kind',kind,'key',dedupe_key,'status',status,'payload',payload) order by created_at, dedupe_key),'[]') from public.review_alert_events;`));

    // 1回目（機能の開始前からある口コミ）: すべて baseline、総合点は比較対象が無いので変化なし
    ingest(tabelog("t1", 3.26, [rv("B1:11", jst(3)), rv("B2:excerpt", jst(5))], 49));
    assert.deepEqual(events().map((e) => e.status), ["baseline", "baseline"]);
    assert.equal(psql(`select public_url is null from public.source_stores where store_key='13245351';`), "t", "public_url は agent-api が更新する");

    // 2回目: 新着1件（送る）・古い投稿1件（送らない）・抜粋→全文（同じ口コミ）・総合点 3.26 → 3.28
    ingest(tabelog("t2", 3.28, [rv("B1:11", jst(3)), rv("B2:excerpt", jst(5)), rv("B2:22", jst(5), "全文"), rv("B3:33", jst(1)), rv("B4:excerpt", jst(100))], 50));
    const after = events().slice(2);
    const byKey = Object.fromEntries(after.map((e) => [e.key.replace(/^(review|score):tabelog:13245351:/, ""), e]));
    assert.equal(byKey.B3.status, "pending");
    assert.equal(byKey.B3.payload.text, "おいしかった");
    assert.equal(byKey.B4.status, "skipped", "投稿日が60日より前");
    assert.equal(byKey.B2, undefined, "抜粋と全文は同じ口コミ（B-group）で二度記録しない");
    const sc = after.find((e) => e.kind === "score_change");
    assert.deepEqual([sc.status, sc.payload.from, sc.payload.to, sc.payload.review_count_from, sc.payload.review_count_to], ["pending", 3.26, 3.28, 49, 50]);

    // 同じ値の再取り込み・総合点なし（null）は変化にしない。戻った（3.28 → 3.26）は新しい変化
    ingest(tabelog("t3", 3.28, [], 50));
    ingest(normalizeSourceIngest({ schemaVersion: 1, source: "tabelog", runId: "t4", agent: "grok-bot", capturedAt: new Date().toISOString(),
      stores: [{ storeKey: "13245351", daily: [{ date: jst(2), pv: 10 }] }] }, today)); // 総合点なし（アクセス数だけ）
    ingest(tabelog("t5", 3.26, [], 50));
    assert.deepEqual(events().filter((e) => e.kind === "score_change").map((e) => [e.payload.from, e.payload.to]), [[3.26, 3.28], [3.28, 3.26]]);

    // 確保は1回だけ（2回目は空）。10分以上止まった送信は同じ batch_id のまま戻る
    const claim = () => JSON.parse(psql(`select coalesce(json_agg(c.dedupe_key order by c.dedupe_key),'[]') from public.claim_review_alert_events('${USER}', 50) c;`));
    assert.equal(claim().length, 3);
    assert.deepEqual(claim(), []);
    psql(`update public.review_alert_events set batch_id=gen_random_uuid(), claimed_at=now()-interval '11 minutes' where dedupe_key like 'review:tabelog:13245351:B3';`);
    assert.deepEqual(claim(), ["review:tabelog:13245351:B3"]);
    assert.equal(psql(`select attempts from public.review_alert_events where dedupe_key='review:tabelog:13245351:B3';`), "2");
    assert.equal(psql(`select has_function_privilege('authenticated', 'public.claim_review_alert_events(uuid,integer)', 'execute');`), "f");

    // 一休: 初回は baseline、次の取り込みの新しい口コミは pending
    const ikyu = (runId, items) => normalizeIkyuIngest({ schemaVersion: 1, runId, agent: "grok-bot", capturedAt: new Date().toISOString(),
      stores: [{ storeId: "112789", name: "ビストロ サヴァサヴァ", reviews: { total: items.length, items } }] }, today);
    const ik = (reservationNo, postedAt) => ({ reservationNo, postedAt, rating: 4.5, scores: [], text: "また来ます", processing: "未返信 ／ 未処理" });
    const ingestIkyu = (n) => psql(`select public.ingest_ikyu('${USER}', $j$${JSON.stringify(n.run)}$j$::jsonb, $j$${JSON.stringify(n.stores)}$j$::jsonb);`);
    ingestIkyu(ikyu("i1", [ik("26090001", jst(10))]));
    ingestIkyu(ikyu("i2", [ik("26090001", jst(10)), ik("26090002", jst(1))]));
    assert.deepEqual(events().filter((e) => e.key.startsWith("review:ikyu")).map((e) => [e.key, e.status]),
      [["review:ikyu:112789:26090001", "baseline"], ["review:ikyu:112789:26090002", "pending"]]);
  } finally {
    try { run("pg_ctl", ["-D", `${dir}/data`, "-m", "immediate", "stop"]); } catch { /* 停止済み */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
