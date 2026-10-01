import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CHOICE_RETIRED, LIVE_LIMITS, failureReason, handleMtalkTurn, isChitChat, parseChoice } from "../../supabase/functions/_shared/mtalk-live.js";
import * as live from "../../supabase/functions/_shared/mtalk-live.js";
import { queueCommand } from "../../scripts/agent-queue.mjs";

const OWNER = "114c1410-ebc0-433a-9d30-e0e2410dec13";
const MU = "11111111-2222-4333-8444-555555555555";

test("parseChoice: digits, full-width, circled, button commands and phrases → 1/2; questions starting with numbers are not choices", () => {
  for (const s of ["1", "１", "①", " 1 ", "1.", "1：サイトにログインして最新を調べる", "1番", "1でお願いします", "1にします", "【1】", "最新を調べて", "サイトにログインして最新を調べる"]) assert.equal(parseChoice(s), 1, s);
  for (const s of ["2", "２", "②", "2：今あるデータですぐ答える", "2を選びます", "2で", "今あるデータで答えて", "いまあるデータですぐ答えて"]) assert.equal(parseChoice(s), 2, s);
  for (const s of ["1月の予約は？", "12月のPVは", "2024年と比べて", "1 日の予約件数は", "1.5倍になった理由", "3", "", "今月のPVは？", `1 ${"あ".repeat(60)}`]) assert.equal(parseChoice(s), null, s);
});

test("isChitChat: greetings / thanks / acks / how-to → answered directly; data questions are not", () => {
  for (const s of ["こんにちは", "ありがとうございます！", "了解です", "OK", "おつかれさまです〜", "何ができる？", "使い方", "テスト", "👍"]) assert.equal(isChitChat(s), true, s);
  for (const s of ["今月のPVは？", "悪い口コミを教えて", "ありがとう、ところで先月の予約数は？", "一休の予約は増えた？"]) assert.equal(isChitChat(s), false, s);
});

// ---------- 選択の廃止（2026-10-01） ----------
function lookupStore(rows = []) {
  const db = rows.map((r) => ({ history: [], attempts: 0, ...r }));
  return {
    db,
    latestLookup: async () => structuredClone([...db].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null),
    updateLookup: async (id, from, patch) => { const r = db.find((x) => x.id === id && from.includes(x.status)); if (!r) return null; Object.assign(r, patch); return structuredClone(r); },
  };
}
const NOW = Date.parse("2026-10-01T10:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const input = (question) => ({ mtalkUserId: MU, groupId: 7, messageId: 1, question, history: [] });

test("no choice card: data questions and chit-chat both go straight to the answer", async () => {
  const store = lookupStore([{ id: "L1", question: "前の質問", status: "awaiting_choice", created_at: ago(5) }]);
  let answered = 0;
  const deps = { answer: async () => { answered++; return { text: "x" }; }, now: () => NOW };
  for (const q of ["今月のPVは？", "一休の予約は増えた？", "こんにちは", "1月の予約は？"]) {
    assert.deepEqual(await handleMtalkTurn(store, deps, input(q)), { mode: "direct" }, q);
  }
  assert.equal(answered, 0, "呼び出し側（ai-analyst）がすぐ答える");
  assert.equal(store.db[0].status, "awaiting_choice", "ふつうの質問では古い質問に触れない");
  for (const name of ["choiceReply", "selectTargets", "processLiveLookups", "liveSummary", "CHOICE_LABELS", "LIVE_ACK", "LIVE_REPLY_PATH"]) assert.equal(name in live, false, `${name} は廃止`);
});

test("old card buttons / bare 1・2: answer the recent stored question once; otherwise explain the change", async () => {
  const store = lookupStore([{ id: "L1", question: "今月の予約は？", history: [{ role: "user", content: "a" }], status: "timed_out", created_at: ago(30) }]);
  const asked = [];
  const deps = { answer: async (q) => { asked.push(q); return { text: "予約は12件です\n\nデータ：一休 10/1 18:30取得（9/1〜9/30）", links: [] }; }, now: () => NOW };
  const r = await handleMtalkTurn(store, deps, input("2：今あるデータですぐ答える"));
  assert.equal(r.mode, "answer_legacy");
  assert.equal(asked[0].question, "今月の予約は？");
  assert.deepEqual(asked[0].history, [{ role: "user", content: "a" }]);
  assert.match(r.result.text, /^ご質問：「今月の予約は？」\n予約は12件です/);
  assert.match(r.result.text, /データ：一休/, "鮮度の行もそのまま");
  assert.equal(store.db[0].status, "answered");
  const again = await handleMtalkTurn(store, deps, input("1"));
  assert.deepEqual(again, { mode: "guide", parts: [CHOICE_RETIRED] }, "同じ質問に2回は答えない");
  assert.match(CHOICE_RETIRED, /番号で選ぶ必要はなくなりました/);
  const old = lookupStore([{ id: "L2", question: "q", status: "expired", created_at: ago(LIVE_LIMITS.legacyAnswerMinutes + 1) }]);
  assert.equal((await handleMtalkTurn(old, deps, input("1"))).mode, "guide", "2時間を過ぎた質問には答えない");
  assert.equal((await handleMtalkTurn(lookupStore(), deps, input("②"))).mode, "guide");
  const busy = lookupStore([{ id: "L3", question: "q", status: "answering", created_at: ago(1) }]);
  assert.equal((await handleMtalkTurn(busy, deps, input("2"))).mode, "guide");
  const failing = lookupStore([{ id: "L4", question: "q", status: "awaiting_choice", created_at: ago(1) }]);
  await assert.rejects(handleMtalkTurn(failing, { answer: async () => { throw new Error("AI down"); }, now: () => NOW }, input("2")), /AI down/);
  assert.equal(failing.db[0].status, "failed");
});

test("failure reasons stay fixed texts (used by the app history and relogin notices)", () => {
  assert.equal(failureReason("一休: 要再ログイン（セッション切れ）"), "今回は取得できませんでした（こちらの不具合です。次の回にやり直します）", "サイトの表示の無い「要再ログイン」は other");
  assert.equal(failureReason("一休: サイトに「パスワードが正しくありません」と表示"), "ログイン情報の確認が必要です");
  assert.equal(failureReason(""), "今回は取得できませんでした（こちらの不具合です。次の回にやり直します）");
});

test("agent-queue CLI: --origin mtalk_live for --list / --claim only", () => {
  assert.deepEqual(queueCommand({ _: [], claim: true, origin: "mtalk_live" }), { path: "/requests/claim", body: { agent: "grok-bot", limit: 1, origin: "mtalk_live" } });
  assert.deepEqual(queueCommand({ _: [], list: true, origin: "mtalk_live" }), { path: "/requests/pending", body: { origin: "mtalk_live" } });
  assert.throws(() => queueCommand({ _: [], claim: true, origin: "night" }), /--origin/);
  assert.throws(() => queueCommand({ _: [], "enqueue-due": true, origin: "mtalk_live" }), /--origin/);
});

test("agent-api / ai-analyst wiring: origin filters kept, followups only, no live answers or choice extras", () => {
  const api = fs.readFileSync(new URL("../../supabase/functions/agent-api/index.ts", import.meta.url), "utf8");
  assert.match(api, /p_origin: origin/);
  assert.match(api, /if \(origin\) query = query\.eq\("origin", origin\)/);
  assert.match(api, /if \(data\?\.origin === "mtalk_live" \|\| data\?\.params\?\.trigger === "relogin"\) liveInBackground\(admin, userId\)/);
  assert.match(api, /liveInBackground\(admin, userId\); \/\/ M-talk/);
  assert.doesNotMatch(api, /processLiveLookups|LIVE_REPLY_PATH|supabaseLiveStore/);
  assert.match(api, /if \(path === "\/pages\/ingest"\)/);
  assert.match(api, /admin\.rpc\("save_site_page_snapshots"/);
  const ai = fs.readFileSync(new URL("../../supabase/functions/ai-analyst/index.ts", import.meta.url), "utf8");
  const fn = ai.slice(ai.indexOf("async function mtalkChat"));
  assert.doesNotMatch(fn, /choice:turn\.choice|live:turn\.live_start|live_close/);
  assert.match(ai, /answerFreshness\(result, ds, \{ todayYear \}\)/, "/ask にも鮮度");
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
    // 022: 選択の廃止で進行中の質問を閉じる（表は残す）
    psql(`update public.mtalk_live_lookups set status='replaced' where status='fetching';
      insert into public.mtalk_live_lookups(owner_user_id, mtalk_user_id, mtalk_group_id, message_id, question, status) values ('${OWNER}', '${MU}', 8, 2, 'q', 'fetching');
      insert into public.mtalk_live_lookups(owner_user_id, mtalk_user_id, mtalk_group_id, message_id, question, status) values ('${OWNER}', '${MU}', 9, 3, 'q', 'awaiting_choice');`);
    psql(fs.readFileSync(path.join(migrations, "022_cache_snapshots_and_choice_removal.sql"), "utf8"));
    assert.equal(psql(`select string_agg(status, ',' order by mtalk_group_id, status) from public.mtalk_live_lookups;`), "answered,replaced,replaced,timed_out,expired");
    assert.equal(psql(`select count(*) from public.mtalk_live_lookups where status in ('awaiting_choice','fetching','answering');`), "0");
  } finally {
    try { run("pg_ctl", ["-D", `${dir}/data`, "-m", "immediate", "stop"]); } catch { /* 停止済み */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
