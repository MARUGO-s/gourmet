import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ALERT_LIMITS, DEFAULT_ALERT_RECIPIENTS, buildAlertMessage, describeAlert, dispatchReviewAlerts, publicAlertSettings, ratingText,
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

// ---------- 設定 ----------
test("alert settings: only own stores, booleans, unique recipients, recipients required when on", () => {
  const ok = validateAlertSettingsInput({ storeId: STORE.toUpperCase(), newReviews: true, scoreChanges: false, recipients: [{ id: ME, name: " itagawa\n yoshito " }] }, [STORE]);
  assert.deepEqual(ok, { store_id: STORE, new_reviews: true, score_changes: false, recipients: [{ id: ME, name: "itagawa yoshito" }] });
  assert.throws(() => validateAlertSettingsInput({ storeId: OTHER, newReviews: true, scoreChanges: true, recipients: [{ id: ME }] }, [STORE]), /店舗/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: "yes", scoreChanges: true, recipients: [{ id: ME }] }, [STORE]), /true/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, recipients: [{ id: ME }, { id: ME.toUpperCase() }] }, [STORE]), /重複/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, recipients: [{ id: "x" }] }, [STORE]), /不正/);
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, recipients: [] }, [STORE]), /1人以上/);
  const many = Array.from({ length: ALERT_LIMITS.recipients + 1 }, (_, i) => ({ id: `3186a986-547f-41c0-81c2-${String(i).padStart(12, "0")}` }));
  assert.throws(() => validateAlertSettingsInput({ storeId: STORE, newReviews: true, scoreChanges: true, recipients: many }, [STORE]), /20人/);
  // 両方オフなら送信先なしでも保存できる
  assert.deepEqual(validateAlertSettingsInput({ storeId: STORE, newReviews: false, scoreChanges: false, recipients: [] }, [STORE]).recipients, []);
});

test("alert settings default to both on and itagawa yoshito", () => {
  assert.deepEqual(resolveAlertSettings(null), { newReviews: true, scoreChanges: true, recipients: [{ ...DEFAULT_ALERT_RECIPIENTS[0] }], isDefault: true });
  assert.equal(DEFAULT_ALERT_RECIPIENTS[0].id, ME);
  const [a, b] = publicAlertSettings([{ id: STORE, name: "BISTRO CAVA CAVA" }, { id: OTHER, name: "店B" }],
    [{ store_id: OTHER, new_reviews: false, score_changes: true, recipients: [{ id: ME, name: "i" }, { id: "bad" }], updated_at: "2026-10-01T00:00:00Z" }]);
  assert.equal(a.isDefault, true);
  assert.deepEqual([b.newReviews, b.scoreChanges, b.recipients.length, b.isDefault, b.updatedAt], [false, true, 1, false, "2026-10-01T00:00:00Z"]);
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
function fakeStore(events, { settings = new Map(), sites = { "tabelog/13245351": { id: STORE, name: "BISTRO CAVA CAVA" } } } = {}) {
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

test("dispatch: one message per store to each recipient, dedupe key per batch, nothing sent twice", async () => {
  const store = fakeStore([review(1), review(2), score(3.26, 3.28)]);
  const sent = [];
  const send = async (to, body) => { sent.push({ to, body }); return { ok: true, group_id: 7, message_id: 70 }; };
  const r = await dispatchReviewAlerts(store, { send, newId: ids() });
  assert.deepEqual([r.claimed, r.sent, r.retry, r.failed], [3, 3, 0, 0]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ME);
  assert.equal(sent[0].body.recipient_user_id, ME);
  assert.equal(sent[0].body.dedupe_key, "gourmet-alert:00000000-0000-4000-8000-000000000001");
  assert.equal(sent[0].body.reviews.length, 2);
  assert.equal(sent[0].body.score_changes.length, 1);
  assert.deepEqual(store.db.deliveries.map((d) => [d.status, d.new_reviews, d.score_changes, d.mtalk_message_id]), [["sent", 2, 1, 70]]);
  assert.ok(store.db.events.every((e) => e.status === "sent"));
  const again = await dispatchReviewAlerts(store, { send, newId: ids() });
  assert.equal(again.claimed, 0);
  assert.equal(sent.length, 1);
});

test("dispatch: settings off → skipped with reason; no recipients → skipped", async () => {
  const settings = new Map([[STORE, { store_id: STORE, new_reviews: false, score_changes: true, recipients: [{ id: ME, name: "i" }] }]]);
  const store = fakeStore([review(1), score(3.26, 3.28)], { settings });
  const sent = [];
  const r = await dispatchReviewAlerts(store, { send: async (to, b) => { sent.push(b); return {}; }, newId: ids() });
  assert.deepEqual([r.sent, r.skipped], [1, 1]);
  assert.equal(sent[0].reviews.length, 0);
  assert.equal(store.db.events.find((e) => e.kind === "new_review").reason, "通知の設定がオフ");
  const none = fakeStore([review(1)], { settings: new Map([[STORE, { store_id: STORE, new_reviews: true, score_changes: true, recipients: [] }]]) });
  const r2 = await dispatchReviewAlerts(none, { send: async () => assert.fail("送らない"), newId: ids() });
  assert.equal(r2.skipped, 1);
  assert.equal(none.db.events[0].reason, "送信先が未設定");
});

test("dispatch: M-talk not configured → nothing is claimed", async () => {
  const store = fakeStore([review(1)]);
  const r = await dispatchReviewAlerts(store, { configured: false, send: async () => assert.fail("送らない") });
  assert.equal(r.notConfigured, true);
  assert.equal(store.db.events[0].status, "pending");
});

test("dispatch: temporary failure keeps the batch and retries only unsent recipients; 404 is permanent; 5 attempts → failed", async () => {
  const OTHER_USER = "7a1f1b53-9d3e-4b6e-8f59-2d7a4a2c1e10";
  const settings = new Map([[STORE, { store_id: STORE, new_reviews: true, score_changes: true, recipients: [{ id: ME, name: "i" }, { id: OTHER_USER, name: "o" }] }]]);
  const store = fakeStore([review(1)], { settings });
  const calls = [];
  let down = true;
  const send = async (to, body) => {
    calls.push([to, body.dedupe_key]);
    if (to === OTHER_USER && down) throw Object.assign(new Error("M-talk に接続できませんでした"), { status: 502 });
    return { ok: true };
  };
  const first = await dispatchReviewAlerts(store, { send, newId: ids() });
  assert.deepEqual([first.retry, first.sent], [1, 0]);
  assert.equal(store.db.events[0].status, "pending");
  const batch = store.db.events[0].batch_id;
  down = false;
  const second = await dispatchReviewAlerts(store, { send, newId: () => assert.fail("新しい batch は作らない") });
  assert.equal(second.sent, 1);
  assert.deepEqual(calls.map((c) => c[0]), [ME, OTHER_USER, OTHER_USER], "送信済みの送信先には再送しない");
  assert.ok(calls.every((c) => c[1] === `gourmet-alert:${batch}`), "やり直しも同じ dedupe_key（M-talk 側でも二重投稿しない）");

  const gone = fakeStore([review(2)]);
  const r404 = await dispatchReviewAlerts(gone, { send: async () => { throw Object.assign(new Error("見つかりません"), { status: 404 }); }, newId: ids() });
  assert.deepEqual([r404.failed, r404.retry], [1, 0]);
  assert.equal(gone.db.deliveries[0].status, "failed");

  const tired = fakeStore([review(3, { attempts: ALERT_LIMITS.maxAttempts - 1 })]);
  const rTired = await dispatchReviewAlerts(tired, { send: async () => { throw Object.assign(new Error("x"), { status: 500 }); }, newId: ids() });
  assert.equal(rTired.failed, 1);
  assert.match(tired.db.events[0].reason, /5回/);
});

test("dispatch: stale 'sending' events come back with their batch id and are grouped by it", async () => {
  const store = fakeStore([review(1, { batch_id: "b-old" }), review(2)]);
  const keys = [];
  await dispatchReviewAlerts(store, { send: async (_to, b) => { keys.push(b.dedupe_key); return {}; }, newId: () => "b-new" });
  assert.deepEqual(keys.sort(), ["gourmet-alert:b-new", "gourmet-alert:b-old"]);
});

test("dispatch: unassigned site stores still alert with the site store name to the default recipient", async () => {
  const store = fakeStore([review(1, { store_key: "99999999" })]);
  const got = [];
  await dispatchReviewAlerts(store, { send: async (to, b) => { got.push([to, b.store_name]); return {}; }, newId: ids() });
  assert.deepEqual(got, [[ME, "未割り当て 99999999"]]);
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
