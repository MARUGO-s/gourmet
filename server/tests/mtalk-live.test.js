import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CHOICE_LABELS, LIVE_ACK, LIVE_LIMITS, choiceReply, describeTargets, failureReason, handleMtalkTurn, isChitChat, liveSummary, parseChoice,
  processLiveLookups, selectTargets } from "../../supabase/functions/_shared/mtalk-live.js";
import { splitReply } from "../../supabase/functions/_shared/mtalk-chat.js";
import { queueCommand } from "../../scripts/agent-queue.mjs";

const OWNER = "114c1410-ebc0-433a-9d30-e0e2410dec13";
const MU = "11111111-2222-4333-8444-555555555555";
const CAVA = [{ source: "tabelog", storeId: "", storeName: "BISTRO CAVACAVA" }, { source: "ikyu", storeId: "112789", storeName: "BISTRO CAVACAVA" }];

// ---------- 選択・あいさつの判定 ----------
test("parseChoice: digits, full-width, circled, button commands and phrases → 1/2; questions starting with numbers are not choices", () => {
  for (const s of ["1", "１", "①", " 1 ", "1.", "1：サイトにログインして最新を調べる", "1番", "1でお願いします", "1にします", "【1】", "最新を調べて", "サイトにログインして最新を調べる"]) assert.equal(parseChoice(s), 1, s);
  for (const s of ["2", "２", "②", "2：今あるデータですぐ答える", "2を選びます", "2で", "今あるデータで答えて", "いまあるデータですぐ答えて"]) assert.equal(parseChoice(s), 2, s);
  for (const s of ["1月の予約は？", "12月のPVは", "2024年と比べて", "1 日の予約件数は", "1.5倍になった理由", "3", "", "今月のPVは？", `1 ${"あ".repeat(60)}`]) assert.equal(parseChoice(s), null, s);
});

test("isChitChat: greetings / thanks / acks / how-to → answered directly; data questions are not", () => {
  for (const s of ["こんにちは", "ありがとうございます！", "了解です", "OK", "おつかれさまです〜", "何ができる？", "使い方", "テスト", "👍"]) assert.equal(isChitChat(s), true, s);
  for (const s of ["今月のPVは？", "悪い口コミを教えて", "ありがとう、ところで先月の予約数は？", "一休の予約は増えた？"]) assert.equal(isChitChat(s), false, s);
});

test("selectTargets: defaults to all credentialed tabelog/ikyu; narrows by site or store name mentioned in the question", () => {
  const avail = [...CAVA, { source: "google", storeId: "", storeName: "BISTRO CAVACAVA" }, { source: "tabelog", storeId: "x2", storeName: "MARUGO 2" }];
  assert.deepEqual(selectTargets("今月の口コミは？", avail).map((t) => `${t.source}:${t.storeName}`), ["tabelog:BISTRO CAVACAVA", "ikyu:BISTRO CAVACAVA", "tabelog:MARUGO 2"], "Google は取得手順が無い");
  assert.deepEqual(selectTargets("一休の予約は？", avail).map((t) => t.source), ["ikyu"]);
  assert.deepEqual(selectTargets("カヴァカヴァの食べログ", avail).map((t) => `${t.source}:${t.storeId}`), ["tabelog:"]);
  assert.deepEqual(selectTargets("マルゴセカンドの点数", avail).map((t) => t.storeName), ["MARUGO 2"]);
  assert.deepEqual(selectTargets("ホットペッパーは？", avail).length, 3, "取得できないサイトの指定なら絞らない");
  assert.deepEqual(selectTargets("x", []), []);
});

test("choice reply: text fallback (1/2) + structured choice for card buttons; labels exactly as specified", () => {
  assert.equal(CHOICE_LABELS[1], "サイトにログインして最新を調べる（時間がかかります：5〜10分ほど）");
  assert.equal(CHOICE_LABELS[2], "今あるデータですぐ答える（少し正確性が落ちることがあります）");
  const r = choiceReply("今月のPVは？", { expiresAt: "2026-10-01T05:30:00.000Z" });
  assert.match(r.parts[0], /1\. サイトにログインして最新を調べる（時間がかかります：5〜10分ほど）/);
  assert.match(r.parts[0], /2\. 今あるデータですぐ答える/);
  assert.match(r.parts[0], /30分以内/);
  assert.deepEqual(r.choice.options.map((o) => o.value), [1, 2]);
  assert.match(choiceReply("q", { replacedFetching: true }).parts[0], /^前の質問の「最新を調べる」は取りやめました/);
  assert.ok(choiceReply("あ".repeat(500)).choice.question.length <= LIVE_LIMITS.questionExcerpt + 1);
});

test("failure reasons and the freshness header (all ok / partial / none)", () => {
  assert.equal(failureReason("一休: 要再ログイン（セッション切れ）"), "要再ログイン");
  assert.equal(failureReason("追加認証が必要でした"), "追加認証が必要");
  assert.equal(failureReason("24時間以内に取得されませんでした。もう一度依頼してください"), "取得が始まりませんでした");
  assert.equal(failureReason(""), "理由不明");
  const lookup = { question: "今月の予約は？", targets: [{ ...CAVA[0], requestId: "r1" }, { ...CAVA[1], requestId: "r2" }] };
  const done = (id, at) => ({ id, status: "done", finished_at: at });
  const all = liveSummary(lookup, [done("r1", "2026-10-01T05:03:00Z"), done("r2", "2026-10-01T05:07:00Z")]);
  assert.match(all.header, /ご質問：「今月の予約は？」/);
  assert.match(all.header, /サイトにログインして最新のデータを取得しました（10\/1 14:07 取得、BISTRO CAVACAVA の食べログ・一休）/);
  assert.equal(all.failed.length, 0);
  const part = liveSummary(lookup, [done("r1", "2026-10-01T05:03:00Z"), { id: "r2", status: "failed", error: "要再ログイン" }]);
  assert.match(part.header, /10\/1 14:03 取得、BISTRO CAVACAVA の食べログ/);
  assert.match(part.header, /一休（BISTRO CAVACAVA）: 要再ログイン のため更新できませんでした。一休は前回までに取得したデータで答えています/);
  assert.match(part.system, /取り直せなかった: 一休/);
  const none = liveSummary({ ...lookup, targets: [{ ...CAVA[1], enqueueError: "取得の依頼が多すぎるため依頼できませんでした" }] }, []);
  assert.match(none.header, /最新のデータを取得できませんでした（一休（BISTRO CAVACAVA）: 取得を依頼できませんでした）。前回までに取得したデータで答えます/);
  assert.equal(none.refreshedAny, false);
  assert.equal(describeTargets([{ source: "tabelog", storeName: "A" }, { source: "ikyu", storeName: "B" }]), "A の食べログ、B の一休");
});

// ---------- 状態の移り変わり（メモリ上の保存先） ----------
function memoryStore({ targets = CAVA, enqueueFail = {} } = {}) {
  const db = { lookups: [], requests: [], seq: 0 };
  const pick = (r) => (r ? structuredClone(r) : null);
  return {
    db,
    latestLookup: async (u, g) => pick([...db.lookups].reverse().find((r) => r.mtalk_user_id === u && r.mtalk_group_id === g)),
    updateLookup: async (id, from, patch) => { const r = db.lookups.find((x) => x.id === id && from.includes(x.status)); if (!r) return null; Object.assign(r, patch); return pick(r); },
    insertLookup: async (row) => {
      if (db.lookups.some((x) => x.mtalk_user_id === row.mtalk_user_id && x.mtalk_group_id === row.mtalk_group_id && ["awaiting_choice", "fetching", "answering"].includes(x.status))) throw Object.assign(new Error("dup"), { code: "23505" });
      const r = { id: `L${++db.seq}`, created_at: new Date().toISOString(), targets: [], request_ids: [], attempts: 0, ...row }; db.lookups.push(r); return pick(r);
    },
    openLiveLookups: async (o) => db.lookups.filter((r) => r.owner_user_id === o && ["fetching", "answering"].includes(r.status)).map(pick),
    requestsByIds: async (ids) => db.requests.filter((r) => ids.includes(r.id)).map(pick),
    listTargets: async () => targets,
    enqueueRequest: async (_o, t, lookupId) => {
      if (enqueueFail[t.source]) throw new Error(enqueueFail[t.source]);
      const r = { id: `R${++db.seq}`, source: t.source, store_id: t.storeId, status: "queued", origin: "mtalk_live", lookupId }; db.requests.push(r); return { id: r.id };
    },
  };
}
const base = { mtalkUserId: MU, groupId: 7, history: [{ role: "user", content: "前の話" }], ownerUserId: OWNER, liveAllowed: true };
let msg = 100;
const turn = (store, deps, question, extra = {}) => handleMtalkTurn(store, deps, { ...base, messageId: ++msg, question, ...extra });
const answerSpy = () => { const calls = []; return { calls, answer: async (a) => { calls.push(a); return { text: `回答:${a.question}` }; } }; };

test("data question → stored choice (no AI call); 「2」 → answers the stored question with stored history right away", async () => {
  const store = memoryStore(), spy = answerSpy();
  const deps = { answer: spy.answer, now: () => Date.now() };
  const r = await turn(store, deps, "今月のPVは？");
  assert.equal(r.mode, "choice");
  assert.equal(spy.calls.length, 0, "選択肢を出すだけ（AIは呼ばない）");
  assert.equal(store.db.lookups[0].status, "awaiting_choice");
  assert.equal(store.db.lookups[0].question, "今月のPVは？");
  const a = await turn(store, deps, "2：今あるデータですぐ答える", { history: [{ role: "user", content: "別" }] });
  assert.equal(a.mode, "answer_now");
  assert.match(a.text, /^（今あるデータでの回答です）\n回答:今月のPVは？/);
  assert.deepEqual(spy.calls[0].history, [{ role: "user", content: "前の話" }], "保存した会話履歴を使う");
  assert.equal(store.db.lookups[0].status, "answered");
  assert.equal(store.db.lookups[0].choice, 2);
  assert.equal(a.live_close, undefined);
  assert.equal((await turn(store, deps, "2")).mode, "guide", "もう選べる質問は無い");
});

test("chit-chat, no credentialed sites, or owner the agent can't fetch for → answered directly without a choice", async () => {
  const deps = { answer: async () => ({ text: "x" }) };
  assert.equal((await turn(memoryStore(), deps, "ありがとう！")).mode, "direct");
  assert.equal((await turn(memoryStore({ targets: [] }), deps, "今月のPVは？")).mode, "direct");
  assert.equal((await turn(memoryStore(), deps, "今月のPVは？", { liveAllowed: false })).mode, "direct");
});

test("「1」 → mtalk_live requests per target, immediate ack + live_start; double press doesn't enqueue twice; new question replaces", async () => {
  const store = memoryStore(), deps = { answer: async () => ({ text: "x" }), now: () => Date.now() };
  await turn(store, deps, "今月の予約は？");
  const r = await turn(store, deps, "1：サイトにログインして最新を調べる");
  assert.equal(r.mode, "live_started");
  assert.match(r.parts[0], new RegExp(`^${LIVE_ACK}。`));
  assert.match(r.parts[0], /対象: BISTRO CAVACAVA の食べログ・一休/);
  assert.deepEqual(r.live_start, { lookup_id: "L1", deadline_seconds: 1200 });
  const L = store.db.lookups[0];
  assert.equal(L.status, "fetching");
  assert.equal(L.request_ids.length, 2);
  assert.ok(Date.parse(L.deadline_at) - Date.parse(L.chosen_at) === 20 * 60_000);
  assert.deepEqual(store.db.requests.map((x) => [x.source, x.origin, x.lookupId]), [["tabelog", "mtalk_live", "L1"], ["ikyu", "mtalk_live", "L1"]]);
  const again = await turn(store, deps, "1");
  assert.equal(again.mode, "busy");
  assert.equal(store.db.requests.length, 2, "二重に依頼しない");
  const next = await turn(store, deps, "先週の口コミは？");
  assert.equal(next.mode, "choice");
  assert.match(next.parts[0], /前の質問の「最新を調べる」は取りやめました/);
  assert.deepEqual(next.live_close, ["L1"], "line_report の見張りを閉じる");
  assert.equal(store.db.lookups[0].status, "replaced");
});

test("「1」 with a failed enqueue for one site → continues with the other; all failed → back to the choice with guidance", async () => {
  const store = memoryStore({ enqueueFail: { ikyu: "取得の依頼が多すぎるため依頼できませんでした" } }), deps = { answer: async () => ({ text: "x" }) };
  await turn(store, deps, "今月の予約は？");
  const r = await turn(store, deps, "1");
  assert.match(r.parts[0], /BISTRO CAVACAVA の一休 は取得を依頼できなかったため/);
  assert.equal(store.db.lookups[0].targets.find((t) => t.source === "ikyu").enqueueError, "取得の依頼が多すぎるため依頼できませんでした");
  const s2 = memoryStore({ enqueueFail: { ikyu: "x", tabelog: "取得の依頼が多すぎるため依頼できませんでした" } });
  await turn(s2, deps, "今月の予約は？");
  const r2 = await turn(s2, deps, "1");
  assert.equal(r2.mode, "guide");
  assert.match(r2.parts[0], /「2」を送ると今あるデータで答えます/);
  assert.equal(s2.db.lookups[0].status, "awaiting_choice", "「2」を選べるまま");
});

test("choice expires after 30 minutes; 「2」 still works while fetching (impatient) and closes the live watch", async () => {
  let now = Date.parse("2026-10-01T05:00:00Z");
  const store = memoryStore(), spy = answerSpy(), deps = { answer: spy.answer, now: () => now };
  await turn(store, deps, "今月の予約は？");
  now += 31 * 60_000;
  assert.equal((await turn(store, deps, "1")).mode, "guide");
  assert.equal(store.db.lookups[0].status, "expired");
  await turn(store, deps, "今月の予約は？");
  await turn(store, deps, "1");
  now += 8 * 60_000;
  const a = await turn(store, deps, "2");
  assert.equal(a.mode, "answer_now");
  assert.deepEqual(a.live_close, ["L2"]);
  assert.equal(store.db.lookups[1].status, "answered");
  // あとから取得が終わっても、もう答えない
  for (const r of store.db.requests) r.status = "done";
  const posted = [];
  const out = await processLiveLookups(store, { ...deps, post: async (x) => posted.push(x), split: splitReply }, OWNER);
  assert.equal(out.checked, 0);
  assert.equal(posted.length, 0);
});

test("live completion: waits until every request ends, answers once with the freshness header, M-talk timeout (409) → timed_out", async () => {
  let now = Date.parse("2026-10-01T05:00:00Z");
  const store = memoryStore(), spy = answerSpy();
  const posted = [];
  const deps = { answer: spy.answer, now: () => now, split: splitReply, post: async (x) => { posted.push(x); return { ok: true }; } };
  await turn(store, deps, "今月の予約は？");
  await turn(store, deps, "1");
  const [rt, ri] = store.db.requests;
  rt.status = "done"; rt.finished_at = "2026-10-01T05:06:00Z";
  assert.deepEqual(await processLiveLookups(store, deps, OWNER), { checked: 1, answered: 0, waiting: 1, timedOut: 0, failed: 0, retry: 0 });
  ri.status = "failed"; ri.error = "一休: 要再ログイン";
  const out = await processLiveLookups(store, deps, OWNER);
  assert.equal(out.answered, 1);
  assert.equal(posted.length, 1);
  assert.match(posted[0].parts[0], /^ご質問：「今月の予約は？」\nサイトにログインして最新のデータを取得しました（10\/1 14:06 取得、BISTRO CAVACAVA の食べログ）。\n一休（BISTRO CAVACAVA）: 要再ログイン のため更新できませんでした/);
  assert.match(posted[0].parts[0], /回答:今月の予約は？/);
  assert.match(spy.calls[0].system, /取り直せなかった: 一休/);
  assert.equal(spy.calls[0].lookup.id, "L1");
  assert.equal(store.db.lookups[0].status, "answered");
  assert.equal((await processLiveLookups(store, deps, OWNER)).checked, 0, "1回だけ答える");

  const s2 = memoryStore();
  const d2 = { ...deps, post: async () => { throw Object.assign(new Error("timeout"), { status: 409 }); } };
  await turn(s2, d2, "今月の予約は？"); await turn(s2, d2, "1");
  for (const r of s2.db.requests) r.status = "done";
  assert.equal((await processLiveLookups(s2, d2, OWNER)).timedOut, 1);
  assert.equal(s2.db.lookups[0].status, "timed_out");
  const late = await turn(s2, d2, "2");
  assert.equal(late.mode, "answer_now", "時間切れの案内のあとでも「2」で答えられる");
});

test("live completion: post failure retries (bounded), answer failure posts guidance, stuck requests are cleaned up after the deadline", async () => {
  let now = Date.parse("2026-10-01T05:00:00Z");
  const store = memoryStore();
  let fail = true;
  const posted = [];
  const deps = { answer: async () => ({ text: "ok" }), now: () => now, split: splitReply, post: async (x) => { if (fail) throw new Error("502"); posted.push(x); } };
  await turn(store, deps, "今月の予約は？"); await turn(store, deps, "1");
  for (const r of store.db.requests) r.status = "done";
  assert.equal((await processLiveLookups(store, deps, OWNER)).retry, 1);
  assert.equal(store.db.lookups[0].status, "fetching");
  fail = false;
  assert.equal((await processLiveLookups(store, deps, OWNER)).answered, 1);
  assert.equal(store.db.lookups[0].attempts, 2);

  const s2 = memoryStore();
  const p2 = [];
  const d2 = { ...deps, answer: async () => { throw new Error("openai down"); }, post: async (x) => p2.push(x) };
  await turn(s2, d2, "今月の予約は？"); await turn(s2, d2, "1");
  for (const r of s2.db.requests) r.status = "done";
  assert.equal((await processLiveLookups(s2, d2, OWNER)).failed, 1);
  assert.match(p2[0].parts[0], /回答を作れませんでした。「2」を送ると、取り直したデータで答えます/);

  const s3 = memoryStore();
  await turn(s3, deps, "今月の予約は？"); await turn(s3, deps, "1");
  now += 31 * 60_000;
  assert.equal((await processLiveLookups(s3, deps, OWNER)).timedOut, 1);
  assert.equal(s3.db.lookups[0].status, "timed_out");

  const s4 = memoryStore();
  await turn(s4, deps, "今月の予約は？"); await turn(s4, deps, "1");
  Object.assign(s4.db.lookups[0], { status: "answering", answering_at: new Date(now - 6 * 60_000).toISOString(), attempts: 3 });
  assert.equal((await processLiveLookups(s4, deps, OWNER)).failed, 1, "止まった回答作成は3回まで");
});

test("agent-queue CLI: --origin mtalk_live for --list / --claim only", () => {
  assert.deepEqual(queueCommand({ _: [], claim: true, origin: "mtalk_live" }), { path: "/requests/claim", body: { agent: "grok-bot", limit: 1, origin: "mtalk_live" } });
  assert.deepEqual(queueCommand({ _: [], list: true, origin: "mtalk_live" }), { path: "/requests/pending", body: { origin: "mtalk_live" } });
  assert.throws(() => queueCommand({ _: [], claim: true, origin: "night" }), /--origin/);
  assert.throws(() => queueCommand({ _: [], "enqueue-due": true, origin: "mtalk_live" }), /--origin/);
});

test("agent-api / ai-analyst wiring: origin filters, live answers in background after complete/fail and on pending", () => {
  const api = fs.readFileSync(new URL("../../supabase/functions/agent-api/index.ts", import.meta.url), "utf8");
  assert.match(api, /p_origin: origin/);
  assert.match(api, /if \(origin\) query = query\.eq\("origin", origin\)/);
  assert.match(api, /if \(data\?\.origin === "mtalk_live"\) liveInBackground\(admin, userId\)/);
  assert.match(api, /liveInBackground\(admin, userId\); \/\/ M-talk/);
  assert.match(api, /mtalkRequest\(mtalk, "POST", LIVE_REPLY_PATH/);
  const sched = fs.readFileSync(new URL("../../supabase/functions/_shared/fetch-schedules.js", import.meta.url), "utf8");
  assert.match(sched, /origin: "schedule"/);
});

// ---------- 実際の Postgres（migration 019） ----------
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

test("real Postgres: origin column/backfill, claim priority and origin filter, legacy 4-arg named call, one active lookup per room", { skip: pgAvailable ? false : "Postgres 17 がありません" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gourmet-live-pg-"));
  const port = String(57000 + Math.floor(Math.random() * 1000));
  const env = { ...process.env, PGHOST: dir, PGPORT: port, PGUSER: "postgres", PGDATABASE: "postgres" };
  const run = (file, args) => execFileSync(`${PG}/${file}`, args, { env, stdio: ["pipe", "pipe", "pipe"] }).toString();
  const psql = (sql) => execFileSync(`${PG}/psql`, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { env, input: sql, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  run("initdb", ["-D", `${dir}/data`, "-U", "postgres", "-A", "trust"]);
  run("pg_ctl", ["-D", `${dir}/data`, "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-l", `${dir}/log`, "-w", "start"]);
  try {
    psql(STUB);
    const migrations = new URL("../../supabase/migrations/", import.meta.url).pathname;
    const files = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "019")) psql(fs.readFileSync(path.join(migrations, f), "utf8"));
    psql(`insert into auth.users(id) values ('${OWNER}');
      insert into public.agent_requests(user_id, source, store_id, action, params) values ('${OWNER}', 'tabelog', '', 'fetch_reviews', '{"trigger":"schedule"}');`);
    for (const f of files.filter((f) => f >= "019")) psql(fs.readFileSync(path.join(migrations, f), "utf8"));
    assert.equal(psql(`select origin from public.agent_requests;`), "schedule", "既存の自動取得の依頼は schedule");
    psql(`insert into public.agent_requests(user_id, source, store_id, action) values ('${OWNER}', 'tabelog', '', 'sync_now');
      select pg_sleep(0.01);
      insert into public.agent_requests(user_id, source, store_id, action, origin) values ('${OWNER}', 'ikyu', '112789', 'sync_now', 'mtalk_live');`);
    assert.throws(() => psql(`insert into public.agent_requests(user_id, source, store_id, origin) values ('${OWNER}', 'ikyu', '112789', 'night');`));
    // 夜間: mtalk_live だけ
    assert.equal(psql(`select string_agg(source || ':' || origin, ',') from public.claim_agent_requests('${OWNER}', 'grok-bot', 5, null, 'mtalk_live');`), "ikyu:mtalk_live");
    // 既存の4つの名前付き引数の呼び出し（いまの agent-api）もそのまま動く。古い順（mtalk_live があれば先）
    psql(`update public.agent_requests set status='queued', claim_id=null, claimed_at=null where origin='mtalk_live';`);
    assert.equal(psql(`select string_agg(origin, ',') from public.claim_agent_requests(p_user => '${OWNER}', p_agent => 'grok-bot', p_limit => 1, p_source => null);`), "mtalk_live", "mtalk_live を先に取得");
    assert.equal(psql(`select string_agg(origin, ',' order by requested_at) from public.claim_agent_requests(p_user => '${OWNER}', p_agent => 'grok-bot', p_limit => 5, p_source => null);`), "schedule,app");
    assert.throws(() => psql(`select * from public.claim_agent_requests('${OWNER}', 'x', 1, null, 'bogus');`), /Invalid origin/);
    assert.equal(psql(`select count(*) from pg_proc where proname='claim_agent_requests';`), "1", "4引数版は残さない（名前付き呼び出しが曖昧にならない）");
    assert.equal(psql(`select has_function_privilege('authenticated', 'public.claim_agent_requests(uuid,text,integer,text,text)', 'execute');`), "f");
    // 1つのトークで進行中は1件
    const ins = (status) => psql(`insert into public.mtalk_live_lookups(owner_user_id, mtalk_user_id, mtalk_group_id, message_id, question, status)
      values ('${OWNER}', '${MU}', 7, 1, '今月のPVは？', '${status}') returning status;`);
    ins("awaiting_choice");
    assert.throws(() => ins("fetching"), /mtalk_live_lookups_one_active/);
    psql(`update public.mtalk_live_lookups set status='replaced';`);
    ins("fetching");
    ins("answered");
    assert.equal(psql(`select count(*) from public.mtalk_live_lookups;`), "3");
    assert.equal(psql(`select relrowsecurity from pg_class where relname='mtalk_live_lookups';`), "t");
    assert.equal(psql(`select has_table_privilege('authenticated', 'public.mtalk_live_lookups', 'select');`), "f");
    assert.equal(psql(`select extract(epoch from expires_at - created_at)::int from public.mtalk_live_lookups limit 1;`), "1800");
    // 再適用しても壊れない
    psql(fs.readFileSync(path.join(migrations, "019_mtalk_live_lookups.sql"), "utf8"));
  } finally {
    try { run("pg_ctl", ["-D", `${dir}/data`, "-m", "immediate", "stop"]); } catch { /* 停止済み */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
