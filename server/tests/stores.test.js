import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  validateStoreInput, validateSiteInput, validateReorder, siteKeyError, publicStores, buildSiteIndex, storeFor, keysForStore, unassignedKeys, scopeKeys,
  inScope, combineKeyValues, reviewStoreKey, filterReviews, storeSnapshots, referenceMonth, buildOverview, sortOverviewRows, filterByStore, storeLabelFor,
  UNASSIGNED, STORE_SOURCES,
} from "../../supabase/functions/_shared/stores.js";
import { computeDashboard } from "../../supabase/functions/_shared/dashboard.js";

const CAVA = "11111111-1111-4111-8111-111111111111";
const OTTO = "22222222-2222-4222-8222-222222222222";
const stores = [
  { id: OTTO, name: "MARUGO-OTTO", sort_order: 2 },
  { id: CAVA, name: "BISTRO CAVACAVA", sort_order: 16 },
];
const sites = [
  { id: "a", store_id: CAVA, source: "ikyu", site_store_key: "112789" },
  { id: "b", store_id: CAVA, source: "tabelog", site_store_key: "13245351" },
  { id: "c", store_id: CAVA, source: "tabelog", site_store_key: "" },
  { id: "d", store_id: OTTO, source: "tabelog", site_store_key: "13000001" },
];

test("店舗名・サイトの店舗IDの入力を検証する", () => {
  assert.deepEqual(validateStoreInput({ name: "  BISTRO   CAVACAVA " }), { name: "BISTRO CAVACAVA" });
  assert.deepEqual(validateStoreInput({ name: "eric'S", sortOrder: 17 }), { name: "eric'S", sort_order: 17 });
  assert.deepEqual(validateStoreInput({ sortOrder: 3 }, { partial: true }), { sort_order: 3 });
  for (const bad of [{}, { name: "" }, { name: "x".repeat(101) }, { name: "a", sortOrder: -1 }, { name: "a", sortOrder: 1.5 }, null]) assert.throws(() => validateStoreInput(bad), undefined, JSON.stringify(bad));
  assert.throws(() => validateStoreInput({}, { partial: true }));
  assert.deepEqual(validateSiteInput({ source: "ikyu", siteStoreKey: "112789" }), { source: "ikyu", site_store_key: "112789" });
  assert.deepEqual(validateSiteInput({ source: "tabelog", siteStoreKey: " 13245351 " }), { source: "tabelog", site_store_key: "13245351" });
  assert.deepEqual(validateSiteInput({ source: "tabelog" }), { source: "tabelog", site_store_key: "" });
  for (const bad of [{ source: "ikyu", siteStoreKey: "" }, { source: "ikyu", siteStoreKey: "12345" }, { source: "x", siteStoreKey: "1" }, { source: "google", siteStoreKey: "店" }, { source: "google", siteStoreKey: "a".repeat(41) }]) {
    assert.throws(() => validateSiteInput(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(siteKeyError("ikyu", "112789"), null);
  assert.match(siteKeyError("ikyu", "1"), /6桁/);
  assert.deepEqual(STORE_SOURCES, ["tabelog", "hotpepper", "google", "toreta", "ikyu", "retty"]);
});

test("並び替えは全店舗の重複なしの一覧だけを受け付ける", () => {
  assert.deepEqual(validateReorder({ ids: [CAVA, OTTO] }, [OTTO, CAVA]), [{ id: CAVA, sort_order: 1 }, { id: OTTO, sort_order: 2 }]);
  assert.throws(() => validateReorder({ ids: [CAVA] }, [OTTO, CAVA]), /読み込み直して/);
  assert.throws(() => validateReorder({ ids: [CAVA, CAVA] }, [CAVA]));
  assert.throws(() => validateReorder({ ids: ["x"] }, ["x"]));
});

test("店舗の一覧は表示順、サイトはサイト順に並べる", () => {
  const list = publicStores(stores, sites);
  assert.deepEqual(list.map((s) => s.name), ["MARUGO-OTTO", "BISTRO CAVACAVA"]);
  assert.deepEqual(list[1].sites.map((s) => `${s.source}:${s.siteStoreKey}`), ["tabelog:", "tabelog:13245351", "ikyu:112789"]);
});

test("サイトの店舗コードから店舗を引き、割り当ての無いコードは未割り当てにする", () => {
  const index = buildSiteIndex(sites);
  assert.equal(storeFor(index, "ikyu", "112789"), CAVA);
  assert.equal(storeFor(index, "tabelog", ""), CAVA);
  assert.equal(storeFor(index, "tabelog", "99999999"), null);
  assert.deepEqual([...keysForStore(CAVA, sites).tabelog].sort(), ["", "13245351"]);
  const loose = unassignedKeys(sites, [{ source: "tabelog", key: "99999999" }, { source: "ikyu", key: "112789" }, { source: "google", key: "" }]);
  assert.deepEqual(Object.fromEntries(Object.entries(loose).map(([k, v]) => [k, [...v]])), { tabelog: ["99999999"], google: [""] });
  assert.equal(scopeKeys("all", sites), null);
  assert.ok(scopeKeys(UNASSIGNED, sites, [{ source: "google", key: "" }]).google.has(""));
  assert.equal(inScope(null, "x", "y"), true);
  // 公開の型（storeId / siteStoreKey）でも同じ
  const pub = publicStores(stores, sites).flatMap((s) => s.sites);
  assert.equal(storeFor(buildSiteIndex(pub), "tabelog", "13000001"), OTTO);
  assert.equal(storeLabelFor(stores, pub, "ikyu", "112789"), "BISTRO CAVACAVA");
  assert.equal(storeLabelFor(stores, pub, "ikyu", "999999"), "未割り当て（999999）");
});

test("資格情報・依頼・設定を店舗の店舗コードで絞り込む", () => {
  const creds = [{ source: "ikyu", storeKey: "112789" }, { source: "tabelog", storeKey: "" }, { source: "tabelog", storeKey: "13000001" }, { source: "ikyu", storeKey: "222222" }];
  assert.deepEqual(filterByStore(creds, keysForStore(CAVA, sites)), creds.slice(0, 2));
  assert.deepEqual(filterByStore(creds, keysForStore(OTTO, sites)), [creds[2]]);
  assert.equal(filterByStore(creds, null).length, 4);
  const requests = [{ source: "tabelog", storeId: "13245351" }, { source: "ikyu", storeId: "222222" }];
  assert.deepEqual(filterByStore(requests, keysForStore(CAVA, sites), (r) => r.storeId), [requests[0]]);
});

test("店舗コード '' は同じ店舗の他のコードに値が無いときだけ使う（旧データの二重計上を防ぐ）", () => {
  assert.equal(combineKeyValues([{ key: "", value: 100 }, { key: "13245351", value: 120 }]), 120);
  assert.equal(combineKeyValues([{ key: "", value: 100 }, { key: "13245351", value: null }]), 100);
  assert.equal(combineKeyValues([{ key: "a", value: 1 }, { key: "b", value: 2 }]), 3);
  assert.equal(combineKeyValues([{ key: "a", value: 3.21 }, { key: "b", value: 3.5 }], "avg"), 3.36);
  assert.equal(combineKeyValues([{ key: "a", value: null }]), null);
  assert.equal(combineKeyValues([{ key: "", value: 0 }]), 0);
});

test("口コミの店舗コード（取り込み・一休の公開口コミID・旧データ）で店舗を絞り込む", () => {
  const reviews = [
    { id: 1, source: "tabelog", external_id: "B1:2", details: { storeId: "13245351" } },
    { id: 2, source: "tabelog", external_id: "B3:4", details: {} },
    { id: 3, source: "ikyu", external_id: "I112789:305ca13a07989a902773", details: { origin: "public" } },
    { id: 4, source: "ikyu", external_id: "ikyu:222222:1", details: { storeId: "222222" } },
    { id: 5, source: "tabelog", external_id: "B5:6", details: { storeId: "13000001" } },
  ];
  assert.equal(reviewStoreKey(reviews[1]), "");
  assert.equal(reviewStoreKey(reviews[2]), "112789");
  assert.deepEqual(filterReviews(reviews, keysForStore(CAVA, sites)).map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(filterReviews(reviews, keysForStore(OTTO, sites)).map((r) => r.id), [5]);
  assert.deepEqual(filterReviews(reviews, scopeKeys(UNASSIGNED, sites, [{ source: "ikyu", key: "222222" }])).map((r) => r.id), [4]);
  assert.equal(filterReviews(reviews, null).length, 5);
});

test("店舗単位の日次行: 取り込み行を店舗の店舗コードで集計し、旧データは値の無いサイト×日だけ '' として使う", () => {
  const daily = [
    { source: "tabelog", key: "13245351", date: "2026-09-20", pv: 60, rating: 3.26, reviews: 49 },
    { source: "tabelog", key: "13000001", date: "2026-09-20", pv: 40, rating: 3.5, reviews: 10 },
    { source: "ikyu", key: "112789", date: "2026-09-20", pv: 95 },
    { source: "ikyu", key: "222222", date: "2026-09-20", pv: 5 },
    { source: "ikyu", key: "112789", date: "2026-09-28", rating: 4.38, reviews: 128 },
  ];
  const monthly = [
    { source: "tabelog", key: "13245351", month: "2026-08", reservations: 9 },
    { source: "tabelog", key: "13000001", month: "2026-08", reservations: 4 },
    { source: "ikyu", key: "112789", month: "2026-08", reservations: 6 },
  ];
  // 旧 snapshots（サイト合計）: 09-20 は取り込み行があるので使わない。09-01 は旧データだけ。
  const legacy = [
    { source: "tabelog", date: "2026-09-20", pv: 100, rating: 3.3, reviews: 59, reservations: null },
    { source: "tabelog", date: "2026-09-01", pv: 70, rating: null, reviews: null, reservations: null },
    { source: "tabelog", date: "2026-08-01", pv: null, rating: null, reviews: null, reservations: 13 },
    { source: "tabelog", date: "2026-07-01", pv: 50, rating: null, reviews: null, reservations: 8 },
  ];
  const targets = STORE_SOURCES;
  const cava = storeSnapshots({ targets, keys: keysForStore(CAVA, sites), daily, monthly, legacy });
  const at = (rows, source, date) => rows.find((r) => r.source === source && r.date === date);
  assert.deepEqual(at(cava, "tabelog", "2026-09-20"), { source: "tabelog", date: "2026-09-20", visits: null, pv: 60, rating: 3.26, reviews: 49, reservations: null });
  assert.equal(at(cava, "tabelog", "2026-09-01").pv, 70);
  assert.equal(at(cava, "tabelog", "2026-08-01").reservations, 9); // 取り込みの月別があるので旧データの13は使わない
  assert.deepEqual([at(cava, "tabelog", "2026-07-01").pv, at(cava, "tabelog", "2026-07-01").reservations], [50, 8]);
  assert.equal(at(cava, "ikyu", "2026-09-20").pv, 95);
  assert.equal(at(cava, "ikyu", "2026-09-28").rating, 4.38);
  const otto = storeSnapshots({ targets, keys: keysForStore(OTTO, sites), daily, monthly, legacy });
  assert.deepEqual(otto.map((r) => `${r.source}/${r.date}/${r.pv}/${r.reservations}`), ["tabelog/2026-08-01/null/4", "tabelog/2026-09-20/40/null"]);
  // 対象サイトの絞り込み
  assert.ok(storeSnapshots({ targets: ["ikyu"], keys: keysForStore(CAVA, sites), daily, monthly, legacy }).every((r) => r.source === "ikyu"));
  // computeDashboard へそのまま渡せる
  const d = computeDashboard(cava, [], null, targets, false);
  assert.equal(d.kpis.rating.value, round((3.26 + 4.38) / 2));
  assert.equal(d.kpis.reviews.value, 49 + 128);
});
const round = (v) => Math.round(v * 100) / 100;

test("比較する月は当月より前でPVのある最新の月（指定があればその月）", () => {
  const monthly = [{ month: "2026-09", pv: 1 }, { month: "2026-07", pv: 1 }, { month: "2026-08", pv: null }];
  assert.equal(referenceMonth(monthly, "2026-09"), "2026-07");
  assert.equal(referenceMonth([], "2026-01"), "2025-12");
  assert.equal(referenceMonth(monthly, "2026-09", "2026-05"), "2026-05");
});

test("全店舗の比較: 店舗×サイトの月別PV・前月比・予約・評価・口コミ数・未返信・最終更新と合計、未割り当て", () => {
  const monthly = [
    { source: "tabelog", key: "13245351", month: "2026-08", pv: 1860, reservations: 9 },
    { source: "tabelog", key: "13245351", month: "2026-07", pv: 1500, reservations: 7 },
    { source: "tabelog", key: "", month: "2026-07", pv: 1400, reservations: 7 }, // 旧データ（同じ店舗の別名）→ 使わない
    { source: "tabelog", key: "", month: "2026-06", pv: 1300, reservations: 5 },
    { source: "ikyu", key: "112789", month: "2026-08", pv: 665, reservations: 6 },
    { source: "ikyu", key: "112789", month: "2026-07", pv: 700, reservations: 4 },
    { source: "tabelog", key: "13000001", month: "2026-08", pv: 900, reservations: 3 },
    { source: "ikyu", key: "222222", month: "2026-08", pv: 10, reservations: 0 },
    { source: "tabelog", key: "13245351", month: "2026-09", pv: 300, reservations: null }, // 当月（集計中）
  ];
  const current = [
    { source: "tabelog", key: "13245351", name: "ビストロ", rating: 3.26, reviewCount: 49, unreplied: 0, updatedAt: "2026-09-28T00:00:00Z" },
    { source: "ikyu", key: "112789", name: "ビストロ サヴァサヴァ", rating: 4.38, reviewCount: 128, unreplied: 2, updatedAt: "2026-09-29T00:00:00Z" },
    { source: "tabelog", key: "13000001", name: null, rating: 3.5, reviewCount: 10, unreplied: 0, updatedAt: "2026-09-01T00:00:00Z" },
    { source: "ikyu", key: "222222", name: "別店舗", rating: null, reviewCount: null, unreplied: 1, updatedAt: "2026-09-02T00:00:00Z" },
  ];
  const o = buildOverview({ stores: [...stores, { id: "33333333-3333-4333-8333-333333333333", name: "MARUGO-D", sort_order: 1 }], sites, monthly, current, currentMonth: "2026-09",
    observed: [{ source: "google", key: "" }] });
  assert.equal(o.month, "2026-08");
  assert.equal(o.prevMonth, "2026-07");
  assert.deepEqual(o.stores.map((s) => s.name), ["MARUGO-D", "MARUGO-OTTO", "BISTRO CAVACAVA"]);
  const cava = o.stores[2];
  assert.deepEqual(
    { pv: cava.sites.tabelog.pv, prevPv: cava.sites.tabelog.prevPv, change: cava.sites.tabelog.pvChange, pct: cava.sites.tabelog.pvChangePct, res: cava.sites.tabelog.reservations },
    { pv: 1860, prevPv: 1500, change: 360, pct: 24, res: 9 });
  assert.deepEqual(cava.sites.tabelog.keys, [{ key: "", name: null }, { key: "13245351", name: "ビストロ" }]);
  assert.equal(cava.sites.ikyu.pvChange, -35);
  assert.equal(cava.sites.ikyu.unreplied, 2);
  assert.deepEqual(
    { pv: cava.totals.pv, prevPv: cava.totals.prevPv, change: cava.totals.pvChange, res: cava.totals.reservations, reviews: cava.totals.reviewCount, unreplied: cava.totals.unreplied, rating: cava.totals.rating, updated: cava.totals.lastUpdatedAt },
    { pv: 2525, prevPv: 2200, change: 325, res: 15, reviews: 177, unreplied: 2, rating: 3.82, updated: "2026-09-29T00:00:00Z" });
  // サイト未設定の店舗は空（0ではなく値なし）
  assert.deepEqual(o.stores[0].sites, {});
  assert.equal(o.stores[0].totals.pv, null);
  // OTTO: 前月の値が無いので前月比なし
  assert.equal(o.stores[1].totals.pv, 900);
  assert.equal(o.stores[1].totals.pvChange, null);
  // 未割り当て: 一休 222222 と Google ''（資格情報のみ）
  assert.equal(o.unassigned.name, "未割り当て");
  assert.deepEqual(Object.keys(o.unassigned.sites).sort(), ["google", "ikyu"]);
  assert.equal(o.unassigned.sites.ikyu.pv, 10);
  assert.equal(o.unassigned.sites.google.pv, null);
  // 合計（未割り当てを含む）
  assert.equal(o.totals.pv, 1860 + 665 + 900 + 10);
  assert.equal(o.totals.unreplied, 3);
  assert.equal(o.totals.reservations, 9 + 6 + 3 + 0);
  assert.equal(o.totals.sites.tabelog.pv, 2760);
  assert.deepEqual(o.sources, ["tabelog", "google", "ikyu"]);
  // 何も割り当てていなければ全データが未割り当て
  const none = buildOverview({ stores: [], sites: [], monthly, current, currentMonth: "2026-09" });
  assert.equal(none.unassigned.totals.pv, o.totals.pv - 0);
  assert.equal(none.stores.length, 0);
});

test("比較表の並び替えは値の無い店舗を常に末尾にする", () => {
  const rows = [
    { id: "a", name: "い", sortOrder: 1, totals: { pv: null } },
    { id: "b", name: "あ", sortOrder: 2, totals: { pv: 10 } },
    { id: "c", name: "う", sortOrder: 3, totals: { pv: 30 } },
  ];
  assert.deepEqual(sortOverviewRows(rows, "pv").map((r) => r.id), ["c", "b", "a"]);
  assert.deepEqual(sortOverviewRows(rows, "pv", "asc").map((r) => r.id), ["b", "c", "a"]);
  assert.deepEqual(sortOverviewRows(rows, "name", "asc").map((r) => r.id), ["b", "a", "c"]);
  assert.deepEqual(sortOverviewRows(rows, "sortOrder", "asc").map((r) => r.id), ["a", "b", "c"]);
  const bySite = [{ id: "x", sortOrder: 1, sites: { ikyu: { pv: 5 } }, totals: {} }, { id: "y", sortOrder: 2, sites: {}, totals: {} }, { id: "z", sortOrder: 3, sites: { ikyu: { pv: 9 } }, totals: {} }];
  assert.deepEqual(sortOverviewRows(bySite, "ikyu:pv").map((r) => r.id), ["z", "x", "y"]);
});

test("migration 013 は利用者ごとの表・RLS（本人のSELECTのみ）・店舗コードの一意性を定義し、店舗を作成しない", () => {
  const sql = fs.readFileSync(new URL("../../supabase/migrations/013_stores.sql", import.meta.url), "utf8");
  for (const t of ["stores", "store_sites"]) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
    assert.match(sql, new RegExp(`create policy ${t}_owner_read on public\\.${t} for select to authenticated using \\(\\(select auth\\.uid\\(\\)\\) = user_id\\)`));
  }
  assert.match(sql, /revoke all on public\.stores, public\.store_sites from anon, authenticated/);
  assert.match(sql, /unique \(user_id, source, site_store_key\)/);
  assert.match(sql, /foreign key \(store_id, user_id\) references public\.stores\(id, user_id\) on delete cascade/);
  assert.doesNotMatch(sql, /insert into/i);
  const seed = fs.readFileSync(new URL("../../supabase/seed/013_seed_stores.sql", import.meta.url), "utf8");
  const names = [...seed.matchAll(/\((\d+), '((?:[^']|'')+)'\)/g)].map((m) => [Number(m[1]), m[2].replace(/''/g, "'")]);
  assert.deepEqual(names.map(([n]) => n), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.deepEqual(names.map(([, n]) => n), ["MARUGO-D", "MARUGO-OTTO", "元祖どないや新宿三丁目", "鮨こるり", "MARUGO", "MARUGO2", "MARUGO GRANDE", "MARUGO MARUNOUCHI",
    "マルゴ新橋", "マルゴS", "MARUGO YOTSUYA", "371BAR", "三三五五", "BAR PELOTA", "Claudia2", "BISTRO CAVACAVA", "eric'S", "MITAN", "焼肉マルゴ", "SOBA-JU",
    "Bar Violet", "X&C", "トラットリア ブリッコラ", "BLU NERO"]);
  for (const n of names.map(([, n]) => n)) assert.doesNotThrow(() => validateStoreInput({ name: n }));
  assert.match(seed, /\('ikyu', '112789'\), \('tabelog', '13245351'\)/);
  assert.match(seed, /on conflict \(user_id, name\) do nothing/);
  assert.equal((seed.match(/on conflict \(user_id, source, site_store_key\) do nothing/g) ?? []).length, 2);
});

// 読み込み（review-api から本人のJWTで SELECT）: PostgREST の問い合わせを模した最小のクライアント
function fakeClient(tables) {
  return {
    from(table) {
      const filters = [];
      let limit = Infinity;
      const q = {
        select() { return q; }, order() { return q; },
        eq(c, v) { filters.push((r) => r[c] === v); return q; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
        gte(c, v) { filters.push((r) => String(r[c]) >= v); return q; },
        not(c, op, v) { filters.push((r) => r[c] != null); return q; },
        limit(n) { limit = n; return q; },
        range(from, to) { const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
        then(resolve, reject) { return Promise.resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit), error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
}

test("全店舗の比較の読み込み: 旧データの月別は ''、取り込みの '' があればそちらを使い、取り込みの無いサイトは旧 snapshots の評価を '' とする", async () => {
  const { loadOverviewInputs, loadStoreDailyInputs } = await import("../../supabase/functions/_shared/store-data.js");
  const client = fakeClient({
    source_monthly_metrics: [{ source: "tabelog", store_key: "13245351", month: "2026-08", pv: 1860, reservations: 9 }, { source: "google", store_key: "", month: "2026-08", pv: 5, reservations: null }],
    ikyu_monthly_pageviews: [{ store_id: "112789", month: "2026-08", pv: 665, reservations: 6 }, { store_id: "112789", month: "2020-01", pv: 1, reservations: 1 }],
    source_reports: [{ source: "tabelog", kind: "monthly_metrics", period: "2026-07", data: { pv: 1400, reservations: 7 } }, { source: "google", kind: "monthly_metrics", period: "2026-08", data: { pv: 999 } }],
    source_stores: [{ source: "tabelog", store_key: "13245351", name: "ビストロ", rating: "3.26", review_count: 49, review_total: 60, updated_at: "2026-09-28T00:00:00Z" }],
    ikyu_stores: [{ store_id: "112789", name: "サヴァサヴァ", public_rating: "4.38", public_review_count: 128, review_total: 13, updated_at: "2026-09-29T00:00:00Z", public_updated_at: "2026-09-28T16:00:00Z" }],
    source_reviews: [{ source: "tabelog", store_key: "13245351", needs_reply: true }, { source: "tabelog", store_key: "13245351", needs_reply: false }],
    ikyu_reviews: [{ store_id: "112789", needs_reply: true }, { store_id: "112789", needs_reply: true }],
    credentials: [{ source: "hotpepper", store_key: "" }],
    snapshots: [{ source: "retty", date: "2026-05-01", rating: "3.9", reviews: 74 }],
    sync_log: [{ source: "retty", status: "ok", at: "2026-05-01T00:00:00Z" }],
  });
  const inputs = await loadOverviewInputs(client, { today: "2026-09-29" });
  assert.equal(inputs.currentMonth, "2026-09");
  assert.ok(!inputs.monthly.some((m) => m.month === "2020-01"));
  assert.deepEqual(inputs.monthly.find((m) => m.source === "tabelog" && m.key === ""), { source: "tabelog", key: "", month: "2026-07", pv: 1400, reservations: 7 });
  assert.equal(inputs.monthly.filter((m) => m.source === "google").length, 1); // 取り込みの '' を優先
  assert.deepEqual(inputs.current.find((c) => c.source === "tabelog"), { source: "tabelog", key: "13245351", name: "ビストロ", rating: 3.26, reviewCount: 49, unreplied: 1, updatedAt: "2026-09-28T00:00:00Z" });
  assert.equal(inputs.current.find((c) => c.source === "ikyu").unreplied, 2);
  assert.deepEqual(inputs.current.find((c) => c.source === "retty"), { source: "retty", key: "", name: null, rating: 3.9, reviewCount: 74, unreplied: null, updatedAt: "2026-05-01T00:00:00Z" });
  assert.deepEqual(inputs.observed, [{ source: "hotpepper", key: "" }]);
  const o = buildOverview({ stores, sites, ...inputs });
  assert.equal(o.stores.find((s) => s.id === CAVA).sites.tabelog.prevPv, 1400); // 13245351 に7月が無いので '' の旧データ
  assert.deepEqual(Object.keys(o.unassigned.sites).sort(), ["google", "hotpepper", "retty"]);

  const daily = await loadStoreDailyInputs(fakeClient({
    source_daily_metrics: [{ source: "tabelog", store_key: "13245351", date: "2026-09-20", pv: 60, rating: null, review_count: null }],
    ikyu_stores: [{ store_id: "112789", public_rating: "4.38", public_review_count: 128, public_updated_at: "2026-09-28T16:00:00Z" }],
  }), ["tabelog", "ikyu"]);
  assert.deepEqual(daily.daily.find((d) => d.source === "ikyu"), { source: "ikyu", key: "112789", date: "2026-09-29", rating: 4.38, reviews: 128 }); // 日本時間の日付
});
