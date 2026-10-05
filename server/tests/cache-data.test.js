// 毎日の取り込み（キャッシュ）の広がり: データの鮮度・新しいAIの関数・照合・管理画面のページの保存HTML（migration 022）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FRESHNESS, formatFreshness, freshnessSystemMessage, jstShort, loadFreshness, periodLabel, sitesForAnswer, summarizeFreshness } from "../../supabase/functions/_shared/data-freshness.js";
import { runTool, systemPrompt } from "../../supabase/functions/_shared/ai-analyst.js";
import { buildEvidence, verifyAnswer } from "../../supabase/functions/_shared/answer-verify.js";
import { NEVER_SAVE, PAGE_CATALOG, SNAPSHOT_LIMITS, normalizePageSnapshots, rawPages, routinePageList, scrubSecrets } from "../../supabase/functions/_shared/page-snapshots.js";

const NOW = Date.parse("2026-10-01T10:00:00Z"); // 10/1 19:00 JST
const OWNER = "114c1410-ebc0-433a-9d30-e0e2410dec13";

// ---------- 鮮度 ----------
test("freshness line: per site last ingest (JST) + covered period; stale >36h and missing said plainly", () => {
  assert.equal(jstShort("2026-10-01T09:30:00Z"), "10/1 18:30");
  assert.equal(periodLabel("2026-09-01", "2026-09-30", 2026), "9/1〜9/30");
  assert.equal(periodLabel("2025-12-01", "2026-01-31", 2026), "2025/12/1〜2026/1/31");
  assert.equal(periodLabel("2019-01", "2026-09", 2026), "2019/1月〜2026/9月");
  const entries = summarizeFreshness({ runs: [
    { source: "ikyu", receivedAt: "2026-10-01T09:30:00Z", from: "2026-09-01", to: "2026-09-30" },
    { source: "tabelog", receivedAt: "2026-09-29T06:28:00Z", from: "2026-08-01", to: "2026-09-28" },
  ], now: NOW });
  assert.equal(entries.find((e) => e.source === "ikyu").stale, false);
  assert.equal(entries.find((e) => e.source === "tabelog").stale, true, `${FRESHNESS.staleHours}時間超え`);
  assert.equal(formatFreshness(entries, { todayYear: 2026 }), [
    "データ：一休 10/1 18:30取得（9/1〜9/30）／食べログ 9/29 15:28取得（8/1〜9/28）",
    "※食べログのデータは最後の取得から36時間以上たっています（9/29 15:28取得）。最新の数値ではありません。",
  ].join("\n"));
  const missing = summarizeFreshness({ runs: [], now: NOW });
  assert.match(formatFreshness(missing), /^データ：一休 取り込みなし／食べログ 取り込みなし\n※一休のデータはまだ取り込まれていません（一休の数値はわかりません）。/);
  assert.match(freshnessSystemMessage(entries, { todayYear: 2026 }), /関数の結果に無い日付・月だけを「わかりません」/);
  assert.deepEqual(sitesForAnswer(["一休.comレストラン"], entries).map((e) => e.source), ["ikyu"]);
  assert.deepEqual(sitesForAnswer([], entries).map((e) => e.source), ["ikyu", "tabelog"], "分からなければデータのあるサイト全部");
});

// supabase-js のクエリビルダーの代わり（表ごとの結果を返す）
function fakeClient(tables) {
  const calls = [];
  const builder = (table, q = []) => new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const rows = typeof tables[table] === "function" ? tables[table](q) : tables[table] ?? [];
        return (resolve) => resolve({ data: rows, error: null });
      }
      return (...args) => { q.push([prop, ...args]); return builder(table, q); };
    },
  });
  return { calls, from(table) { calls.push(table); return builder(table); } };
}

test("loadFreshness: covered period comes from the rows of the latest run; unreadable tables never break answers", async () => {
  const runDates = { R1: ["2026-09-01", "2026-09-30"], R2: ["2026-08-01", "2026-09-28"] };
  const range = (q) => {
    const run = q.find((c) => c[0] === "eq" && c[1] === "run_id")?.[2];
    const asc = q.find((c) => c[0] === "order")?.[2]?.ascending !== false;
    const d = runDates[run];
    return d ? [{ date: asc ? d[0] : d[1] }] : [];
  };
  const client = fakeClient({
    ikyu_ingest_runs: [{ id: "R1", received_at: "2026-10-01T09:30:00Z" }],
    agent_ingest_runs: [{ id: "R2", source: "tabelog", received_at: "2026-10-01T06:28:00Z" }, { id: "R0", source: "tabelog", received_at: "2026-09-30T06:28:00Z" }],
    agent_requests: [],
    ikyu_daily_pageviews: range, source_daily_metrics: range,
  });
  const entries = await loadFreshness(client, { now: NOW });
  assert.equal(formatFreshness(entries, { todayYear: 2026 }), "データ：一休 10/1 18:30取得（9/1〜9/30）／食べログ 10/1 15:28取得（8/1〜9/28）");
  const broken = { from() { throw new Error("no table"); } };
  const none = await loadFreshness(broken, { now: NOW });
  assert.deepEqual(none, [], "読めなければ鮮度を付けない（取り込みなしと誤って書かない）");
});

// ---------- 新しい関数 ----------
const CAVA = "11111111-1111-4111-8111-111111111111";
const ds = {
  today: "2026-10-01",
  stores: [{ id: CAVA, name: "BISTRO CAVACAVA", sort_order: 1 }],
  sites: [{ store_id: CAVA, source: "ikyu", site_store_key: "112789" }, { store_id: CAVA, source: "tabelog", site_store_key: "13245351" }],
  daily: [], legacy: [], monthly: [], current: [], reviews: [],
  ikyuDaily: [
    { key: "112789", date: "2026-09-01", guide: 1, plan: 0, other: 0, sp: 1, pc: 0, pv: 1, guideSp: null, guidePc: null, planSp: null, planPc: null, otherSp: null, otherPc: null, reservations: 1, amount: 0 },
    { key: "112789", date: "2026-09-02", guide: 5, plan: 0, other: 0, sp: 2, pc: 3, pv: 5, reservations: null, amount: null },
    { key: "112789", date: "2026-09-10", guide: 20, plan: 10, other: 0, sp: 18, pc: 12, pv: 30, reservations: 3, amount: 95400 },
    { key: "112789", date: "2026-09-20", guide: 30, plan: 4, other: 0, sp: 20, pc: 14, pv: 34, reservations: 4, amount: 95400 },
    { key: "999999", date: "2026-09-20", guide: 999, plan: 0, other: 0, sp: 999, pc: 0, pv: 999, reservations: 99, amount: 9_999_999 },
  ],
  ikyuMonthly: [],
  sourceDaily: [
    { source: "tabelog", key: "13245351", date: "2026-09-01", pv: 150, pvPc: 30, pvSp: 20, pvApp: 100, pvOther: 0 },
    { source: "tabelog", key: "13245351", date: "2026-09-02", pv: 50, pvPc: 10, pvSp: 10, pvApp: 30, pvOther: 0 },
  ],
  sourceMonthly: [
    { source: "tabelog", key: "13245351", month: "2026-08", complete: true, pv: 4000, pvPc: 1000, pvSp: 500, pvApp: 2500, reservations: 9, calls: 4, mapPrints: 2 },
    { source: "tabelog", key: "13245351", month: "2026-09", complete: false, pv: 4753, pvPc: 1017, pvSp: 499, pvApp: 3237, reservations: 14, calls: 5, mapPrints: 0 },
  ],
  reports: [
    { source: "tabelog", key: "13245351", kind: "device_summary", period: "2026-09", updatedAt: "2026-10-01T06:28:00Z", data: { from: "2026-09-01", to: "2026-09-30", devices: { pc: { topPage: 451, allPages: 1017 } } } },
    { source: "tabelog", key: "13245351", kind: "device_summary", period: "2026-08", updatedAt: "2026-09-01T06:28:00Z", data: { from: "2026-08-01", to: "2026-08-31", devices: {} } },
    { source: "tabelog", key: "13245351", kind: "area_ranking", period: "2026-09-30", updatedAt: "2026-10-01T06:28:00Z", data: { area: "曙橋・四ツ谷三丁目", self: { rank: 4, pv: 4753 }, total: 20 } },
  ],
  freshness: summarizeFreshness({ runs: [{ source: "ikyu", receivedAt: "2026-10-01T09:30:00Z", from: "2026-09-01", to: "2026-09-30" }], now: NOW }),
};
const ctx = { store: CAVA, from: "2026-09-01", to: "2026-09-30" };
const call = (name, args = {}) => JSON.parse(runTool(ds, name, args, ctx));

test("get_reservation_sales: Ikyu accepted-date count/amount with average; Tabelog monthly visit indicators; other stores excluded", () => {
  const r = call("get_reservation_sales", { granularity: "month" });
  const ikyu = r.bySite["一休.comレストラン"];
  assert.equal(ikyu.reservations, 8);
  assert.equal(ikyu.amount, 190800);
  assert.equal(ikyu.averageAmountPerReservation, 23850);
  assert.match(ikyu.basis, /受付日ベース。来店日ではない/);
  assert.deepEqual(ikyu.rows, [{ period: "2026-09", days: 4, reservations: 8, amount: 190800, averageAmountPerReservation: 23850 }]);
  const tabelog = r.bySite["食べログ"];
  assert.deepEqual(tabelog.rows, [{ month: "2026-09", complete: false, netReservations: 14, calls: 5, mapPrints: 0 }]);
  assert.match(tabelog.basis, /金額はサイトに表示されない/);
  const days = call("get_reservation_sales", { source: "ikyu", granularity: "day" });
  assert.deepEqual(days.bySite["一休.comレストラン"].rows.map((x) => x.period), ["2026-09-01", "2026-09-10", "2026-09-20"], "予約のあった日だけ");
  assert.deepEqual(days.sites, ["一休.comレストラン"]);
  const empty = call("get_reservation_sales", { from: "2026-07-01", to: "2026-07-31" });
  assert.match(empty.notes.join(" "), /一休.comレストラン: この期間の予約・売上の取り込みはありません/);
});

test("get_pv_breakdown / get_site_reports / get_data_freshness", () => {
  const b = call("get_pv_breakdown");
  const ikyu = b.bySite["一休.comレストラン"];
  assert.equal(ikyu.pv, 70);
  assert.deepEqual(ikyu.byPageType["プラン"], { total: 14, sp: null, pc: null, sharePct: 20 });
  assert.equal(ikyu.spSharePct, 58.57);
  const t = b.bySite["食べログ"];
  assert.deepEqual(t.daily, { days: 2, pv: 200, pc: 40, sp: 30, app: 130, pcSharePct: 20, spSharePct: 15, appSharePct: 65 });
  assert.equal(t.monthly[0].app, 3237);
  const rep = call("get_site_reports", { kind: "device_summary" });
  assert.equal(rep.reports.length, 1, "種類ごとに最新だけ");
  assert.equal(rep.reports[0].data.devices.pc.allPages, 1017);
  assert.equal(call("get_site_reports").reports.length, 2);
  const f = call("get_data_freshness");
  assert.equal(f.bySite[0].site, "一休");
  assert.equal(f.bySite[1].missing, true);
});

test("verifier: new tool numbers (sums, averages, 万円) are supported; （予想） lines are kept apart from facts", () => {
  const evidence = buildEvidence([call("get_reservation_sales", { granularity: "month" })]);
  assert.equal(verifyAnswer("一休の9月の予約は8件、合計190,800円（1件あたり23,850円）です〔T1〕。", evidence).ok, true);
  assert.equal(verifyAnswer("一休の9月の売上は約19.1万円です〔T1〕。", evidence).ok, true);
  assert.equal(verifyAnswer("一休の9月の予約は777件です〔T1〕。", evidence).ok, false, "合わない数値は通さない");
  assert.equal(verifyAnswer("今月の着地は12件ほどになりそうです（予想）。", evidence).ok, true, "（予想）の行は照合から外す");
  assert.match(systemPrompt("2026-10-01"), /（予想）/);
  assert.match(systemPrompt("2026-10-01"), /get_reservation_sales/);
  assert.match(systemPrompt("2026-10-01"), /電話番号・メールアドレス・住所/);
});

// ---------- 管理画面のページの保存HTML ----------
const html = (body = "<table><tr><td>1</td></tr></table>") => `<html><body>${body}</body></html>`;
const page = (p = {}) => ({ source: "ikyu", storeKey: "112789", page: "ikyu_sales_plan", period: "2026-09", url: "https://restaurant.ikyu.com/rsOwner/v2/112789/legacy?path=/scriptO/rsOwnSalesResultPlanList.asp", html: html(), ...p });

test("page catalog: every menu page is listed once; reservations are PII; account/payment pages are never saved", () => {
  for (const [source, list] of Object.entries(PAGE_CATALOG)) {
    assert.equal(new Set(list.map((p) => p.page)).size, list.length, `${source} のページ名が重複`);
    for (const p of list) {
      assert.match(p.page, /^[a-z][a-z0-9_]{0,59}$/);
      assert.ok(["parsed", "raw"].includes(p.status) && ["month", "current"].includes(p.period));
      assert.ok(!NEVER_SAVE.some((n) => p.title.includes(n)), p.title);
      assert.ok(!/password|credit|bank|api_tokens|owner_info|change_loginid/i.test(p.url), p.url);
    }
  }
  for (const pg of ["ikyu_reservations", "ikyu_reservations_today", "ikyu_billing", "tabelog_reservation_results", "tabelog_cancel_history", "tabelog_owner_home"]) {
    assert.equal([...PAGE_CATALOG.ikyu, ...PAGE_CATALOG.tabelog].find((p) => p.page === pg).pii, true, pg);
  }
  assert.ok(rawPages("ikyu").some((p) => p.page === "ikyu_plans") && rawPages("tabelog").some((p) => p.page === "tabelog_courses"));
  const list = routinePageList("tabelog", "", Date.parse("2026-01-15T03:00:00Z"));
  assert.ok(list.some((p) => p.url.endsWith("start_month=202601") && p.period === "2026-01"));
  assert.ok(list.some((p) => p.url.endsWith("start_month=202512") && p.period === "2025-12"), "1月の前月は前年12月");
  assert.ok(list.some((p) => p.url.includes("start_month=202512&end_month=202601")));
  assert.ok(routinePageList("ikyu", "112789").every((p) => !p.url.includes("{")), "URLの差し込みが残らない");
});

test("normalizePageSnapshots: catalog pages only, right host, size caps, secrets scrubbed, PII flag from the catalog", () => {
  const rows = normalizePageSnapshots({ schemaVersion: 1, runKey: "pages-1", capturedAt: "2026-10-01T09:00:00Z", pages: [
    page(),
    page({ page: "ikyu_reservations", period: "2026-10-01", url: "https://restaurant.ikyu.com/rsOwner/v2/112789/legacy?path=/scriptO/rsOwnRsrvSrchList.asp",
      html: html('<form><input type="password" name="pw" value="hunter2"><input name="authenticity_token" value="abc"><input name="rsv" value="R-1"></form>') }),
  ] }, { now: NOW });
  assert.equal(rows[0].contains_pii, false);
  assert.equal(rows[1].contains_pii, true);
  assert.ok(!rows[1].html.includes("hunter2") && !rows[1].html.includes('value="abc"'), "パスワード・トークンの値は保存しない");
  assert.ok(rows[1].html.includes('value="R-1"'), "ほかの値は残す");
  assert.equal(rows[0].url_path, "/rsOwner/v2/112789/legacy?path=/scriptO/rsOwnSalesResultPlanList.asp");
  const bad = (p, re) => assert.throws(() => normalizePageSnapshots({ schemaVersion: 1, runKey: "k", pages: [page(p)] }, { now: NOW }), re);
  bad({ page: "ikyu_api_tokens" }, /カタログにありません/);
  bad({ url: "https://evil.example.com/x" }, /restaurant\.ikyu\.com/);
  bad({ url: "http://restaurant.ikyu.com/x" }, /restaurant\.ikyu\.com/);
  bad({ storeKey: "abc" }, /storeKey/);
  bad({ period: "2026-10-01" }, /YYYY-MM です/);
  bad({ html: "not html" }, /html がありません/);
  bad({ html: html("x".repeat(SNAPSHOT_LIMITS.htmlBytes)) }, /バイトまで/);
  assert.throws(() => normalizePageSnapshots({ schemaVersion: 1, runKey: "k", pages: [page(), page()] }, { now: NOW }), /重複/);
  assert.throws(() => normalizePageSnapshots({ schemaVersion: 2, runKey: "k", pages: [page()] }), /schemaVersion/);
  assert.equal(scrubSecrets('<meta name="csrf-token" content="x"><p>a</p>'), "<p>a</p>");
});

// ---------- 実際の Postgres（migration 022） ----------
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

test("real Postgres: site_page_snapshots is service-role only, upserts latest per page × period, re-parse on change, PII purge", { skip: pgAvailable ? false : "Postgres 17 がありません" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gourmet-snap-pg-"));
  const port = String(59000 + Math.floor(Math.random() * 900));
  const env = { ...process.env, PGHOST: dir, PGPORT: port, PGUSER: "postgres", PGDATABASE: "postgres" };
  const run = (file, args) => execFileSync(`${PG}/${file}`, args, { env, stdio: ["pipe", "pipe", "pipe"] }).toString();
  const psql = (sql) => execFileSync(`${PG}/psql`, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { env, input: sql, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  run("initdb", ["-D", `${dir}/data`, "-U", "postgres", "-A", "trust"]);
  run("pg_ctl", ["-D", `${dir}/data`, "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-l", `${dir}/log`, "-w", "start"]);
  try {
    psql(STUB);
    const migrations = new URL("../../supabase/migrations/", import.meta.url).pathname;
    for (const f of fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) psql(fs.readFileSync(path.join(migrations, f), "utf8"));
    psql(`insert into auth.users(id) values ('${OWNER}');`);
    const rows = normalizePageSnapshots({ schemaVersion: 1, runKey: "pages-1", capturedAt: "2026-10-01T09:00:00Z", pages: [
      page(), page({ page: "ikyu_reservations", period: "2026-10-01", url: "https://restaurant.ikyu.com/rsOwner/v2/112789/x" }),
    ] }, { now: NOW });
    const save = (r) => psql(`select public.save_site_page_snapshots('${OWNER}', $j$${JSON.stringify(r)}$j$::jsonb);`);
    assert.deepEqual(JSON.parse(save(rows)), { saved: 2, changed: 2 });
    psql(`update public.site_page_snapshots set parsed_at = now();`);
    assert.deepEqual(JSON.parse(save(rows)), { saved: 2, changed: 0 }, "同じHTMLの再送は冪等");
    assert.equal(psql(`select count(*) from public.site_page_snapshots where parsed_at is not null;`), "2", "内容が同じなら解析済みのまま");
    save([{ ...rows[0], html: html("<p>changed</p>") }]);
    assert.equal(psql(`select string_agg(page || ':' || (parsed_at is null), ',' order by page) from public.site_page_snapshots;`), "ikyu_reservations:false,ikyu_sales_plan:true", "変わったページだけ解析し直す");
    assert.equal(psql(`select count(*) from public.site_page_snapshots;`), "2", "店舗×サイト×ページ×期間で1件");
    assert.equal(psql(`select contains_pii from public.site_page_snapshots where page='ikyu_reservations';`), "t");
    assert.equal(psql(`select relrowsecurity from pg_class where relname='site_page_snapshots';`), "t");
    for (const role of ["anon", "authenticated"]) {
      assert.equal(psql(`select has_table_privilege('${role}', 'public.site_page_snapshots', 'select');`), "f", role);
      assert.equal(psql(`select has_function_privilege('${role}', 'public.save_site_page_snapshots(uuid,jsonb)', 'execute');`), "f", role);
    }
    assert.equal(psql(`select has_table_privilege('service_role', 'public.site_page_snapshots', 'select');`), "t");
    assert.throws(() => psql(`insert into public.site_page_snapshots(user_id, source, store_key, page, period, html, bytes, sha256, run_key) values ('${OWNER}', 'ikyu', 'abc', 'x', '2026-09', '<p>', 3, repeat('a', 64), 'k');`), /check/);
    psql(`update public.site_page_snapshots set received_at = now() - interval '200 days';`);
    assert.equal(psql(`select public.purge_site_page_snapshots(120);`), "1", "個人情報を含む古い行だけ消す");
    assert.equal(psql(`select string_agg(page, ',') from public.site_page_snapshots;`), "ikyu_sales_plan");
    psql(fs.readFileSync(path.join(migrations, "022_cache_snapshots_and_choice_removal.sql"), "utf8")); // 再適用しても壊れない
  } finally {
    try { run("pg_ctl", ["-D", `${dir}/data`, "-m", "immediate", "stop"]); } catch { /* 停止済み */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
