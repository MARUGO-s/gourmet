import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FAILURE_KINDS, classifyFailure, failureKindOf, publicRequest, validateFinish } from "../../supabase/functions/_shared/agent-requests.js";
import { DEEP_LINK_PARAMS, credentialUpdateUrl, loginLinks, parseDeepLink } from "../../supabase/functions/_shared/login-help.js";
import { HUMAN_CHECK_GUIDE, RELOGIN_GUIDE, failureReason, liveSummary, processLiveLookups } from "../../supabase/functions/_shared/mtalk-live.js";
import { FOLLOWUP_TITLE, followupMessage, planRefetch, processFollowups } from "../../supabase/functions/_shared/mtalk-followups.js";
import { queueCommand } from "../../scripts/agent-queue.mjs";

const OWNER = "114c1410-ebc0-433a-9d30-e0e2410dec13";
const MU = "11111111-2222-4333-8444-555555555555";
const R1 = "aaaaaaaa-1111-4111-8111-111111111111";
const R2 = "a9f5c78b-fb5d-4dfc-9125-47567ad83329";
const LK = "42338654-ea1b-4a6e-a8c4-c5b8a0428eaa";

// ---------- 失敗の種類 ----------
test("failure kinds: explicit kind wins; legacy free text is classified (human check before relogin)", () => {
  assert.deepEqual(FAILURE_KINDS, ["needs_relogin", "needs_human_check", "other"]);
  // needs_relogin はサイトの画面が ID・パスワードが違うと表示したときだけ（10/1 16:54 の一休の誤ったボタンの再発防止）
  assert.equal(classifyFailure("一休: 要再ログイン（ID・パスワードが通らない）"), "other");
  assert.equal(classifyFailure("一休: 認証エラー（401）"), "other");
  assert.equal(classifyFailure("食べログ: ログインに失敗"), "other");
  assert.equal(classifyFailure("session expired"), "other");
  assert.equal(classifyFailure("一休: ログイン画面に戻された（E-RS-C20008）"), "other");
  assert.equal(classifyFailure("食べログ: サイトに「ログインIDまたはパスワードが正しくありません」と表示"), "needs_relogin");
  assert.equal(classifyFailure("Tabelog: incorrect password"), "needs_relogin");
  assert.equal(classifyFailure("一休: ログインで Cloudflare の「Verify you are human」が出た"), "needs_human_check");
  assert.equal(classifyFailure("一休: 2段階認証の認証コードを求められた"), "needs_human_check");
  assert.equal(classifyFailure("一休: ログイン画面で「私は人間です」の確認が出た"), "needs_human_check");
  assert.equal(classifyFailure("reCAPTCHA の画像パズルが出たため中止（再ログイン不可）"), "needs_human_check");
  assert.equal(classifyFailure("食べログ: 実行サブエージェントにcomputerUseが無く、ブラウザ取得できませんでした"), "other");
  assert.equal(classifyFailure("24時間以内に取得されませんでした。もう一度依頼してください"), "other");
  const id = R1;
  assert.equal(validateFinish({ id, claimId: id, error: "要再ログイン" }, "failed").failureKind, "other", "--kind の無い古い報告");
  assert.equal(validateFinish({ id, claimId: id, error: "一休: 要再ログイン（ID・パスワードが通らない）", failureKind: "needs_relogin" }, "failed").failureKind, "other",
    "サイトの表示が理由に無い needs_relogin は認めない");
  assert.equal(validateFinish({ id, claimId: id, error: "一休: ログインで「私は人間です」の確認", failureKind: "needs_relogin" }, "failed").failureKind, "needs_human_check");
  assert.equal(validateFinish({ id, claimId: id, error: "食べログ: サイトに「パスワードが正しくありません」と表示", failureKind: "needs_relogin" }, "failed").failureKind, "needs_relogin");
  assert.equal(validateFinish({ id, claimId: id, error: "一休: 認証エラー（401）", failureKind: "other" }, "failed").failureKind, "other");
  assert.equal(validateFinish({ id, claimId: id, error: "x", failureKind: "needs_human_check" }, "failed").failureKind, "needs_human_check");
  assert.throws(() => validateFinish({ id, claimId: id, error: "x", failureKind: "needs_verification_code" }, "failed"), /failureKind/);
  assert.equal(validateFinish({ id, claimId: id, result: {} }, "done").failureKind, undefined);
  assert.equal(publicRequest({ id, status: "failed", error: "要再ログイン", failure_kind: null }).failureKind, "other", "列が空の古い行は文から");
  assert.equal(publicRequest({ id, status: "failed", error: "要再ログイン", failure_kind: "needs_relogin" }).failureKind, "needs_relogin", "列の値はそのまま（直すのは migration 021）");
  assert.equal(publicRequest({ id, status: "failed", error: "要再ログイン", failure_kind: "other" }).failureKind, "other", "列があればそれを使う");
  assert.equal(publicRequest({ id, status: "done" }).failureKind, null);
  assert.equal(failureKindOf({ status: "queued", error: "要再ログイン" }), null);
});

test("agent-queue --fail --kind: validated and sent as failureKind; omitted kind stays backward compatible", () => {
  const id = R1;
  assert.deepEqual(queueCommand({ _: [], fail: id, "claim-id": id, error: "一休: 「私は人間です」の確認", kind: "needs_human_check" }),
    { path: "/requests/fail", body: { id, claimId: id, error: "一休: 「私は人間です」の確認", failureKind: "needs_human_check" } });
  assert.deepEqual(queueCommand({ _: [], fail: id, "claim-id": id, error: "要再ログイン" }), { path: "/requests/fail", body: { id, claimId: id, error: "要再ログイン" } });
  assert.throws(() => queueCommand({ _: [], fail: id, "claim-id": id, error: "x", kind: "bogus" }), /--kind/);
  assert.throws(() => queueCommand({ _: [], complete: id, "claim-id": id, kind: "other" }), /--kind は --fail/);
});

// ---------- アプリへのリンク ----------
test("credential links: deep link to the exact store × site; parse rejects junk; only needs_relogin gets a button", () => {
  const url = credentialUpdateUrl({ source: "ikyu", storeKey: "112789", retry: R2 });
  assert.equal(url, `https://marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=112789&retry=${R2}`);
  assert.deepEqual(parseDeepLink(new URL(url).search), { kind: "credentials", source: "ikyu", storeKey: "112789", retry: R2 });
  assert.deepEqual(parseDeepLink("?view=accounts&source=tabelog&store="), { kind: "credentials", source: "tabelog", storeKey: "", retry: null });
  for (const bad of ["", "?view=dashboard", "?view=accounts&source=ikyu&store=12", "?view=accounts&source=<x>&store=1", "?view=accounts&source=tabelog&store=../a"]) assert.equal(parseDeepLink(bad), null, bad);
  assert.equal(parseDeepLink("?view=accounts&source=ikyu&store=112789&retry=nope").retry, null);
  assert.ok(!DEEP_LINK_PARAMS.includes("password"));
  assert.throws(() => credentialUpdateUrl({ source: "ikyu", storeKey: "1/2" }));
  const links = loginLinks([
    { source: "ikyu", storeId: "112789", storeName: "BISTRO CAVACAVA", requestId: R2, kind: "needs_relogin" },
    { source: "ikyu", storeId: "112789", storeName: "BISTRO CAVACAVA", requestId: R2, kind: "needs_relogin" },
    { source: "tabelog", storeId: "", storeName: "BISTRO CAVACAVA", requestId: R1, kind: "needs_human_check" },
    { source: "tabelog", storeId: "", storeName: "X", requestId: R1, kind: "other" },
  ]);
  assert.equal(links.length, 1, "同じボタンは1つ・ログイン情報の問題だけ");
  assert.deepEqual(Object.keys(links[0]).sort(), ["kind", "source", "store_name", "url"]);
  assert.equal(links[0].kind, "relogin");
  assert.ok(!JSON.stringify(links).match(/password|パスワード:/i));
});

// ---------- M-talk の回答 ----------
const CAVA = [{ source: "tabelog", storeId: "", storeName: "BISTRO CAVACAVA", requestId: R1 }, { source: "ikyu", storeId: "112789", storeName: "BISTRO CAVACAVA", requestId: R2 }];
test("live summary: relogin → button + guide (no password in chat); human check → retry guide, no button; legacy text still works", () => {
  const lookup = { question: "今月の予約は？", targets: CAVA };
  const relogin = liveSummary(lookup, [{ id: R1, status: "done", finished_at: "2026-10-01T05:03:00Z" }, { id: R2, status: "failed", error: "一休: 要再ログイン（ID・パスワードが通らない）", failure_kind: "needs_relogin" }]);
  assert.match(relogin.header, /・一休（BISTRO CAVACAVA）：ログイン情報の確認が必要です/);
  assert.ok(!relogin.header.includes("ID・パスワードが通らない"), "理由の文は出さない");
  assert.ok(relogin.header.includes(RELOGIN_GUIDE));
  assert.match(RELOGIN_GUIDE, /パスワードはこのトークに書かないでください/);
  assert.equal(relogin.links.length, 1);
  assert.match(relogin.links[0].url, /source=ikyu&store=112789&retry=a9f5c78b/);
  const legacy = liveSummary(lookup, [{ id: R1, status: "done" }, { id: R2, status: "failed", error: "要再ログイン" }]);
  assert.equal(legacy.links.length, 0, "failure_kind の無い「要再ログイン」だけの行にはボタンを出さない");
  const legacySite = liveSummary(lookup, [{ id: R1, status: "done" }, { id: R2, status: "failed", error: "一休: サイトに「パスワードが正しくありません」と表示" }]);
  assert.equal(legacySite.links.length, 1, "サイトの表示があればボタン");
  const human = liveSummary(lookup, [{ id: R1, status: "done" }, { id: R2, status: "failed", error: "一休: ログインで「私は人間です」の確認（画像パズル）", failure_kind: "needs_human_check" }]);
  assert.equal(human.links.length, 0, "「私は人間です」はボタンを出さない");
  assert.ok(human.header.includes(HUMAN_CHECK_GUIDE));
  assert.match(HUMAN_CHECK_GUIDE, /私は人間です/);
  assert.match(HUMAN_CHECK_GUIDE, /次の回に自動でやり直します/);
  assert.match(HUMAN_CHECK_GUIDE, /Grok Bot のアプリで SiteBot に伝えて/);
  assert.match(human.header, /・一休（BISTRO CAVACAVA）：ログインで「私は人間です」の確認を求められました/);
  assert.ok(!human.header.includes("画像パズル"));
  const other = liveSummary(lookup, [{ id: R1, status: "failed", error: "サイトの表示が変わった", failure_kind: "other" }, { id: R2, status: "done" }]);
  assert.equal(other.links.length, 0);
  assert.ok(!other.header.includes(RELOGIN_GUIDE) && !other.header.includes(HUMAN_CHECK_GUIDE));
  assert.match(other.header, /・食べログ（BISTRO CAVACAVA）：今回は取得できませんでした（こちらの不具合です。次の回にやり直します）/);
  assert.ok(!other.header.includes("サイトの表示が変わった"));
  assert.equal(failureReason("x", "needs_relogin"), "ログイン情報の確認が必要です");
});

test("processLiveLookups posts the relogin links with the answer", async () => {
  const row = { id: LK, owner_user_id: OWNER, mtalk_user_id: MU, mtalk_group_id: 7, question: "今月の予約は？", history: [], status: "fetching", targets: CAVA,
    request_ids: [R1, R2], chosen_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 600_000).toISOString(), attempts: 0 };
  const store = {
    openLiveLookups: async () => [structuredClone(row)],
    requestsByIds: async () => [{ id: R1, status: "done", finished_at: new Date().toISOString() }, { id: R2, status: "failed", error: "要再ログイン", failure_kind: "needs_relogin" }],
    updateLookup: async (_id, _from, patch) => Object.assign(row, patch),
  };
  const posts = [];
  const out = await processLiveLookups(store, { answer: async () => ({ text: "回答" }), post: async (p) => { posts.push(p); }, split: (t) => [t], now: () => Date.now() }, OWNER);
  assert.equal(out.answered, 1);
  assert.equal(posts[0].links.length, 1);
  assert.equal(posts[0].links[0].kind, "relogin");
  assert.ok(!posts[0].parts.join("").includes("password"));
});

// ---------- ログイン情報の保存後の取り直し ----------
test("planRefetch: mtalk_live retry of the same store × site → mtalk_live request tied to the lookup; otherwise a plain app request", () => {
  const retry = { id: R2, source: "ikyu", store_id: "112789", origin: "mtalk_live", params: { trigger: "mtalk_live", lookupId: LK } };
  assert.deepEqual(planRefetch({ source: "ikyu", storeKey: "112789" }, retry),
    { row: { source: "ikyu", store_id: "112789", action: "sync_now", origin: "mtalk_live", params: { trigger: "relogin", retryOf: R2, lookupId: LK } }, lookupId: LK });
  assert.equal(planRefetch({ source: "ikyu", storeKey: "999999" }, retry).lookupId, null, "別の店舗の依頼とはつなげない");
  assert.equal(planRefetch({ source: "ikyu", storeKey: "112789" }, { ...retry, origin: "app" }).row.origin, "app");
  assert.deepEqual(planRefetch({ source: "tabelog", storeKey: "" }, null).row.params, { trigger: "relogin" });
  assert.equal(planRefetch({ source: "google", storeKey: "" }, null), null, "取得手順の無いサイトは依頼しない");
});

test("followup message: done → 再ログイン後の取得結果 + answer; failed relogin → button again; human check → guide", () => {
  const done = followupMessage({ request: { id: R2, source: "ikyu", store_id: "112789", status: "done", finished_at: "2026-10-01T07:40:00Z" }, storeName: "BISTRO CAVACAVA", question: "今月の予約は？" }, "予約は12件です");
  assert.match(done.text, new RegExp(`^【${FOLLOWUP_TITLE}】`));
  assert.match(done.text, /一休（BISTRO CAVACAVA）の最新のデータを取得しました（10\/1 16:40 取得）/);
  assert.match(done.text, /予約は12件です$/);
  assert.equal(done.links.length, 0);
  const again = followupMessage({ request: { id: R2, source: "ikyu", store_id: "112789", status: "failed", error: "要再ログイン", failure_kind: "needs_relogin" }, storeName: "BISTRO CAVACAVA" });
  assert.match(again.text, /ログイン情報の更新後も、取得できませんでした。\n・一休（BISTRO CAVACAVA）：ログイン情報の確認が必要です/);
  assert.equal(again.links.length, 1);
  const human = followupMessage({ request: { id: R2, source: "ikyu", store_id: "112789", status: "failed", error: "私は人間です", failure_kind: "needs_human_check" }, storeName: "B" });
  assert.equal(human.links.length, 0);
  assert.ok(human.text.includes(HUMAN_CHECK_GUIDE));
});

function followupStore(rows) {
  const db = rows.map((r) => ({ attempts: 0, status: "pending", created_at: new Date().toISOString(), ...r }));
  return {
    db,
    openFollowups: async () => db.filter((f) => ["pending", "sending"].includes(f.status)).map((f) => structuredClone(f)),
    updateFollowup: async (id, from, patch) => { const f = db.find((x) => x.request_id === id && from.includes(x.status)); if (!f) return null; Object.assign(f, patch); return { request_id: id }; },
  };
}
const LOOKUP = { id: LK, mtalk_user_id: MU, mtalk_group_id: 7, question: "今月の予約は？", history: [] };

test("processFollowups: waits for the request, sends once (notice_id = request id), retries up to 3 times", async () => {
  const store = followupStore([{ request_id: R2, lookup: LOOKUP, storeName: "BISTRO CAVACAVA", request: { id: R2, source: "ikyu", store_id: "112789", status: "claimed" } }]);
  const notices = [];
  const deps = { answer: async ({ system }) => { assert.match(system, /ログイン情報の更新後/); return { text: "予約は12件です" }; }, notice: async (n) => { notices.push(n); }, split: (t) => [t], now: () => Date.now() };
  assert.equal((await processFollowups(store, deps, OWNER)).waiting, 1);
  assert.equal(notices.length, 0);
  store.db[0].request = { id: R2, source: "ikyu", store_id: "112789", status: "done", finished_at: new Date().toISOString() };
  assert.equal((await processFollowups(store, deps, OWNER)).sent, 1);
  assert.equal(notices[0].noticeId, R2);
  assert.match(notices[0].parts[0], /再ログイン後の取得結果/);
  assert.equal(store.db[0].status, "sent");
  assert.equal((await processFollowups(store, deps, OWNER)).checked, 0, "送ったら終わり");
  // M-talk へ送れない → 3回でやめる
  const s2 = followupStore([{ request_id: R1, lookup: LOOKUP, storeName: "B", request: { id: R1, source: "tabelog", store_id: "", status: "failed", error: "要再ログイン", failure_kind: "needs_relogin" } }]);
  const down = { ...deps, notice: async () => { throw Object.assign(new Error("down"), { status: 502 }); } };
  for (let i = 0; i < 3; i++) await processFollowups(s2, down, OWNER);
  assert.equal(s2.db[0].status, "failed");
  assert.equal(s2.db[0].attempts, 3);
});

// ---------- 配線（ソースの確認） ----------
test("wiring: review-api queues a refetch after saving credentials; agent-api passes the kind and runs followups; password never echoed", () => {
  const review = fs.readFileSync(new URL("../../supabase/functions/review-api/index.ts", import.meta.url), "utf8");
  assert.match(review, /queueRefetchAfterSave\(admin,user\.id,\{source:input\.source,storeKey,retry:input\.retry\?\?null\}\)/);
  assert.match(review, /return json\(req,\{ok:true,refetch\}\)/);
  assert.ok(review.indexOf("password_enc:await encrypt(input.password)") < review.indexOf("queueRefetchAfterSave(admin"), "保存してから依頼");
  const api = fs.readFileSync(new URL("../../supabase/functions/agent-api/index.ts", import.meta.url), "utf8");
  assert.match(api, /p_failure_kind: finish\.failureKind/);
  assert.match(api, /processFollowups\(supabaseFollowupStore\(admin\)/);
  assert.match(api, /mtalkRequest\(mtalk, "POST", NOTICE_PATH/);
  assert.match(api, /\.\.\.\(links\?\.length \? \{ links \} : \{\}\)/);
  const panel = fs.readFileSync(new URL("../../src/components/CredentialsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /preset\.source === source && preset\.storeKey === key \? preset\.retry : null/, "リンクと同じ店舗×サイトのときだけ retry を渡す");
});

// ---------- 実際の Postgres（migration 020） ----------
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

test("real Postgres: failure_kind backfill/check, finish with and without kind (legacy 6 named args), followups locked down", { skip: pgAvailable ? false : "Postgres 17 がありません" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gourmet-kind-pg-"));
  const port = String(58000 + Math.floor(Math.random() * 1000));
  const env = { ...process.env, PGHOST: dir, PGPORT: port, PGUSER: "postgres", PGDATABASE: "postgres" };
  const run = (file, args) => execFileSync(`${PG}/${file}`, args, { env, stdio: ["pipe", "pipe", "pipe"] }).toString();
  const psql = (sql) => execFileSync(`${PG}/psql`, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { env, input: sql, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  run("initdb", ["-D", `${dir}/data`, "-U", "postgres", "-A", "trust"]);
  run("pg_ctl", ["-D", `${dir}/data`, "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-l", `${dir}/log`, "-w", "start"]);
  try {
    psql(STUB);
    const migrations = new URL("../../supabase/migrations/", import.meta.url).pathname;
    const files = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "020")) psql(fs.readFileSync(path.join(migrations, f), "utf8"));
    psql(`insert into auth.users(id) values ('${OWNER}');
      insert into public.agent_requests(user_id, source, store_id, action, status, error) values
        ('${OWNER}', 'ikyu', '112789', 'sync_now', 'queued', null), ('${OWNER}', 'tabelog', '', 'fetch_reviews', 'queued', null), ('${OWNER}', 'tabelog', '', 'backfill', 'queued', null);
      insert into public.agent_requests(user_id, source, store_id, action, status, error) values ('${OWNER}', 'tabelog', '', 'fetch_metrics', 'queued', null);
      update public.agent_requests set status='failed', error=case action when 'sync_now' then '一休: 要再ログイン（ID・パスワードが通らない）' when 'fetch_reviews' then 'ログインで「私は人間です」の確認'
        when 'fetch_metrics' then '食べログ: サイトに「パスワードが正しくありません」と表示' else 'サイトの表示が変わった' end;`);
    psql(fs.readFileSync(path.join(migrations, "020_login_failure_kinds.sql"), "utf8"));
    assert.equal(psql(`select failure_kind from public.agent_requests where action='sync_now';`), "needs_relogin", "020 の古い規則では needs_relogin だった");
    for (const f of files.filter((f) => f > "020")) psql(fs.readFileSync(path.join(migrations, f), "utf8"));
    assert.equal(psql(`select string_agg(action || ':' || failure_kind, ',' order by action) from public.agent_requests;`),
      "backfill:other,fetch_metrics:other,fetch_reviews:needs_human_check,sync_now:other", "021 は「要再ログイン」だけの needs_relogin を直す（other・needs_human_check の行には触れない）");
    assert.throws(() => psql(`update public.agent_requests set failure_kind='needs_verification_code';`), /failure_kind_check/);
    const claim = () => psql(`insert into public.agent_requests(user_id, source, store_id, action) values ('${OWNER}', 'ikyu', '112789', 'fetch_metrics');
      select id || ' ' || claim_id from public.claim_agent_requests('${OWNER}', 'grok-bot', 1);`).split("\n").at(-1).split(" ");
    let [id, cl] = claim();
    assert.equal(psql(`select failure_kind from public.finish_agent_request(p_user => '${OWNER}', p_id => '${id}', p_claim => '${cl}', p_status => 'failed', p_result => null, p_error => '要再ログイン');`), "other", "古い6引数の呼び出し（種類なし）も動き、文から判定する");
    [id, cl] = claim();
    assert.equal(psql(`select failure_kind from public.finish_agent_request('${OWNER}', '${id}', '${cl}', 'failed', null, '一休: 認証エラー（401）', 'needs_relogin');`), "other", "サイトの表示の無い needs_relogin は DB でも認めない");
    [id, cl] = claim();
    assert.equal(psql(`select failure_kind from public.finish_agent_request('${OWNER}', '${id}', '${cl}', 'failed', null, '食べログ: サイトに「パスワードが正しくありません」と表示', 'needs_relogin');`), "needs_relogin");
    [id, cl] = claim();
    assert.equal(psql(`select failure_kind from public.finish_agent_request('${OWNER}', '${id}', '${cl}', 'failed', null, '私は人間です', 'needs_human_check');`), "needs_human_check");
    [id, cl] = claim();
    assert.throws(() => psql(`select * from public.finish_agent_request('${OWNER}', '${id}', '${cl}', 'failed', null, 'x', 'bogus');`), /Invalid failure kind/);
    assert.equal(psql(`select coalesce(failure_kind, 'null') from public.finish_agent_request('${OWNER}', '${id}', '${cl}', 'done', '{}'::jsonb, null, 'needs_relogin');`), "null", "完了には種類を付けない");
    assert.equal(psql(`select count(*) from pg_proc where proname='finish_agent_request';`), "1");
    assert.equal(psql(`select has_function_privilege('authenticated', 'public.finish_agent_request(uuid,uuid,uuid,text,jsonb,text,text)', 'execute');`), "f");
    assert.equal(psql(`select has_column_privilege('authenticated', 'public.agent_requests', 'failure_kind', 'select');`), "t");
    assert.equal(psql(`select relrowsecurity from pg_class where relname='mtalk_followups';`), "t");
    assert.equal(psql(`select has_table_privilege('authenticated', 'public.mtalk_followups', 'select');`), "f");
    assert.equal(psql(`select count(*) from pg_class where relname = 'agent_verification_codes';`), "0", "確認コードの保存先は作らない");
    psql(fs.readFileSync(path.join(migrations, "021_relogin_only_when_site_says.sql"), "utf8"));
  } finally {
    try { run("pg_ctl", ["-D", `${dir}/data`, "-m", "immediate", "stop"]); } catch { /* 停止済み */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
