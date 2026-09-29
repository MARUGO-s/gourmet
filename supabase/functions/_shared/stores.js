// 店舗マスタ（stores）と店舗×サイトの識別子（store_sites）。Node/Edge/ブラウザ共通の純粋モジュール。
// 1店舗 = 複数サイトの店舗ID（一休の6桁の店舗ID、食べログの店舗コード など）をまとめたもの。
// 画面の「店舗の選択」は表示の絞り込みだけで、店長ごとの権限ではない（データは利用者ごとに RLS で分離）。
//
// 店舗コードの扱い:
//   - 取り込みデータ（source_* / ikyu_*）はサイトごとの店舗コード（store_key / store_id）を持つ。
//   - 旧データ（アプリ内取得の時代の snapshots / reviews / source_reports）は店舗コードを持たないため、
//     既定の店舗コード ''（空）のデータとして扱う。
//   - 同じ店舗・同じサイトに '' と他のコード（例 食べログ '' と 13245351）の両方を割り当てた場合、'' は別名として扱い、
//     他のコードに値がある期間は '' の値を使わない（旧データと取り込みデータの二重計上を防ぐ）。
//     '' 以外のコードが複数ある場合は、別々の掲載として合計（評価は平均）する。
//   - どの店舗にも割り当てられていないコードのデータは「未割り当て」にまとめて表示する（データを隠さない）。
import { SOURCE_IDS } from "./sources.js";

export const STORE_SOURCES = SOURCE_IDS;
export const UNASSIGNED = "unassigned";
export const UNASSIGNED_NAME = "未割り当て";
export const ALL_STORES = "all";
export const MAX_STORES = 200;
export const STORE_NAME_MAX = 100;
const SITE_KEY = /^[0-9A-Za-z_-]{0,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (message) => { throw new Error(message); };
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const pairKey = (source, key) => `${source}\u0000${key}`;

export const isStoreId = (value) => typeof value === "string" && UUID.test(value);

// ---------- 入力検証（review-api） ----------
export function validateStoreInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("店舗の入力形式が不正です");
  const row = {};
  if (!partial || input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.normalize("NFC").trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > STORE_NAME_MAX) fail(`店舗名は1〜${STORE_NAME_MAX}文字で入力してください`);
    row.name = name;
  }
  if (input.sortOrder !== undefined) {
    if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 100000) fail("表示順は0以上の整数です");
    row.sort_order = input.sortOrder;
  }
  if (partial && !Object.keys(row).length) fail("変更する項目がありません");
  return row;
}

export function siteKeyError(source, key) {
  if (!STORE_SOURCES.includes(source)) return "不明なサイトです";
  if (typeof key !== "string" || !SITE_KEY.test(key)) return "店舗コードは英数字・_・-の40文字以内で入力してください";
  if (source === "ikyu" && !/^\d{6}$/.test(key)) return "一休の店舗IDは6桁の数字です";
  return null;
}

export function validateSiteInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("サイトの店舗IDの入力形式が不正です");
  const source = String(input.source ?? "");
  const key = typeof input.siteStoreKey === "string" ? input.siteStoreKey.trim() : input.siteStoreKey == null ? "" : String(input.siteStoreKey);
  const error = siteKeyError(source, key);
  if (error) fail(error);
  return { source, site_store_key: key };
}

// 並び替え: 店舗IDの配列（全店舗・重複なし）→ sort_order 1..n
export function validateReorder(input, existingIds) {
  const ids = input?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_STORES || !ids.every(isStoreId) || new Set(ids).size !== ids.length) fail("並び順の形式が不正です");
  const known = new Set(existingIds);
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) fail("店舗の一覧が変更されています。読み込み直してください");
  return ids.map((id, i) => ({ id, sort_order: i + 1 }));
}

export function publicSite(r) {
  return { id: r.id, storeId: r.store_id, source: r.source, siteStoreKey: r.site_store_key };
}
export function sortStores(rows) {
  return [...rows].sort((a, b) => (a.sort_order ?? a.sortOrder ?? 0) - (b.sort_order ?? b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name), "ja") || String(a.id).localeCompare(String(b.id)));
}
export function publicStores(stores, sites) {
  return sortStores(stores).map((s) => ({
    id: s.id, name: s.name, sortOrder: s.sort_order, updatedAt: s.updated_at ?? null,
    sites: sites.filter((x) => x.store_id === s.id).map(publicSite)
      .sort((a, b) => STORE_SOURCES.indexOf(a.source) - STORE_SOURCES.indexOf(b.source) || a.siteStoreKey.localeCompare(b.siteStoreKey)),
  }));
}

// ---------- 割り当て ----------
// sites: [{ store_id | storeId, source, site_store_key | siteStoreKey }]
const siteStore = (s) => s.store_id ?? s.storeId;
const siteKey = (s) => s.site_store_key ?? s.siteStoreKey ?? "";

export function buildSiteIndex(sites) {
  const index = new Map();
  for (const s of sites) index.set(pairKey(s.source, siteKey(s)), siteStore(s));
  return index;
}
export const storeFor = (index, source, key) => index.get(pairKey(source, key ?? "")) ?? null;

// 店舗に割り当てたサイトごとの店舗コード: { tabelog: Set(["13245351",""]), ikyu: Set(["112789"]) }
/** @returns {Record<string, Set<string>>} */
export function keysForStore(storeId, sites) {
  /** @type {Record<string, Set<string>>} */
  const keys = {};
  for (const s of sites) if (siteStore(s) === storeId) (keys[s.source] ??= new Set()).add(siteKey(s));
  return keys;
}
// どの店舗にも割り当てられていない店舗コード（observed: データに現れた { source, key }）
/** @returns {Record<string, Set<string>>} */
export function unassignedKeys(sites, observed) {
  const index = buildSiteIndex(sites);
  /** @type {Record<string, Set<string>>} */
  const keys = {};
  for (const o of observed) if (!storeFor(index, o.source, o.key)) (keys[o.source] ??= new Set()).add(o.key ?? "");
  return keys;
}
// 画面の「店舗の選択」（'all' / 店舗ID / 'unassigned'）→ サイトごとの店舗コード。'all' は null（絞り込まない）
/** @param {string|null|undefined} scope @param {any[]} sites @param {{source:string,key:string}[]} [observed] @returns {Record<string, Set<string>>|null} */
export function scopeKeys(scope, sites, observed = []) {
  if (!scope || scope === ALL_STORES) return null;
  if (scope === UNASSIGNED) return unassignedKeys(sites, observed);
  return keysForStore(scope, sites);
}
export const inScope = (keys, source, key) => !keys || !!keys[source]?.has(key ?? "");

// ---------- 店舗コードごとの値の合成 ----------
// entries: [{ key, value }]。'' 以外に値があればその合計（平均）、無ければ '' の値。
export function combineKeyValues(entries, mode = "sum") {
  const main = entries.filter((e) => e.key !== "" && e.value != null).map((e) => Number(e.value));
  const values = main.length ? main : entries.filter((e) => e.key === "" && e.value != null).map((e) => Number(e.value));
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return mode === "avg" ? round2(sum / values.length) : sum;
}

// 口コミの店舗コード: 取り込み行は details.storeId、一休の公開口コミ（#11）は口コミID I<店舗ID>:…、旧データは ''
export function reviewStoreKey(r) {
  if (r?.details?.storeId != null) return String(r.details.storeId);
  if (r?.source === "ikyu") return /^I(\d{6}):/.exec(String(r.external_id ?? ""))?.[1] ?? "";
  return "";
}
export const filterReviews = (reviews, keys) => (keys ? reviews.filter((r) => inScope(keys, r.source, reviewStoreKey(r))) : reviews);

// ---------- 店舗単位のダッシュボード用の日次行（computeDashboard に渡す snapshots と同じ形） ----------
// daily:   [{ source, key, date, pv?, rating?, reviews? }]   （source_daily_metrics / ikyu_daily_pageviews / ikyu_stores の公開評価）
// monthly: [{ source, key, month, reservations? }]           （source_monthly_metrics / ikyu_monthly_pageviews）
// legacy:  snapshots（サイト全体・店舗コードなし）。店舗コードの行でその項目が無いサイト×日（予約は月）だけ '' の値として使う。
/** @param {{ targets: string[], keys: Record<string, Set<string>>|null, daily?: any[], monthly?: any[], legacy?: any[] }} input */
export function storeSnapshots({ targets, keys, daily = [], monthly = [], legacy = [] }) {
  const fields = [["pv", "sum"], ["rating", "avg"], ["reviews", "sum"]];
  const covered = new Set(); // 店舗コードのある行が値を持つ source/日/項目（全店舗コード）
  for (const d of daily) for (const [f] of fields) if (d[f] != null) covered.add(`${d.source}|${d.date}|${f}`);
  for (const m of monthly) if (m.reservations != null) covered.add(`${m.source}|${m.month}-01|reservations`);
  const groups = new Map(); // source|date → { field → entries }
  const push = (source, date, field, key, value) => {
    const id = `${source}|${date}`;
    const g = groups.get(id) ?? { source, date, entries: {} };
    (g.entries[field] ??= []).push({ key, value });
    groups.set(id, g);
  };
  for (const d of daily) {
    if (!targets.includes(d.source) || !inScope(keys, d.source, d.key)) continue;
    for (const [f] of fields) if (d[f] != null) push(d.source, d.date, f, d.key ?? "", d[f]);
  }
  for (const m of monthly) {
    if (!targets.includes(m.source) || !inScope(keys, m.source, m.key) || m.reservations == null) continue;
    push(m.source, `${m.month}-01`, "reservations", m.key ?? "", m.reservations);
  }
  for (const s of legacy) {
    if (!targets.includes(s.source) || !inScope(keys, s.source, "")) continue;
    const date = String(s.date).slice(0, 10);
    for (const f of ["pv", "rating", "reviews", "reservations"]) {
      if (s[f] == null || covered.has(`${s.source}|${date}|${f}`)) continue;
      push(s.source, date, f, "", s[f]);
    }
  }
  return [...groups.values()].map((g) => ({
    source: g.source, date: g.date, visits: null,
    pv: g.entries.pv ? combineKeyValues(g.entries.pv) : null,
    rating: g.entries.rating ? combineKeyValues(g.entries.rating, "avg") : null,
    reviews: g.entries.reviews ? combineKeyValues(g.entries.reviews) : null,
    reservations: g.entries.reservations ? combineKeyValues(g.entries.reservations) : null,
  })).sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
}

// ---------- 全店舗の比較（総合ページ） ----------
export function previousMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}
export function isMonth(v) { return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v); }

// 比較する月: 指定が無ければ、当月より前でPVのある最新の月（無ければ前月）
/** @param {any[]} monthly @param {string} currentMonth @param {string|null} [requested] */
export function referenceMonth(monthly, currentMonth, requested) {
  if (isMonth(requested)) return requested;
  const months = monthly.filter((m) => m.pv != null && m.month < currentMonth).map((m) => m.month).sort();
  return months.at(-1) ?? previousMonth(currentMonth);
}

const maxIso = (values) => values.filter(Boolean).sort().at(-1) ?? null;
const change = (now, prev) => (now == null || prev == null ? { pvChange: null, pvChangePct: null }
  : { pvChange: now - prev, pvChangePct: prev ? round2(((now - prev) / prev) * 100) : null });
const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

// monthly: [{ source, key, month, pv, reservations }]（旧 source_reports の月別は key ''）
// current: [{ source, key, name, rating, reviewCount, unreplied, updatedAt }]（店舗コードごとの最新値）
function siteAggregate(source, keySet, { monthly, current, month, prev }) {
  const inKeys = (r) => r.source === source && keySet.has(r.key ?? "");
  const monthValue = (m, field) => combineKeyValues(monthly.filter((r) => inKeys(r) && r.month === m).map((r) => ({ key: r.key ?? "", value: r[field] })));
  const cur = current.filter(inKeys);
  const pick = (field, mode) => combineKeyValues(cur.map((r) => ({ key: r.key ?? "", value: r[field] })), mode);
  const pv = monthValue(month, "pv"), prevPv = monthValue(prev, "pv");
  return {
    keys: [...keySet].sort().map((key) => ({ key, name: cur.find((r) => (r.key ?? "") === key)?.name ?? null })),
    pv, prevPv, ...change(pv, prevPv),
    reservations: monthValue(month, "reservations"), prevReservations: monthValue(prev, "reservations"),
    rating: pick("rating", "avg"), reviewCount: pick("reviewCount"),
    // 未返信は口コミ単位の件数なので、店舗コード（旧データの '' を含む）の合計
    unreplied: cur.some((r) => r.unreplied != null) ? cur.reduce((a, r) => a + (r.unreplied ?? 0), 0) : null,
    lastUpdatedAt: maxIso(cur.map((r) => r.updatedAt)),
  };
}

function totalsOf(siteList) {
  const t = { pv: null, prevPv: null, reservations: null, prevReservations: null, reviewCount: null, unreplied: null, lastUpdatedAt: null };
  const ratings = [];
  let prevPvComparable = null, pvComparable = null;
  for (const s of siteList) {
    for (const f of ["pv", "prevPv", "reservations", "prevReservations", "reviewCount", "unreplied"]) t[f] = add(t[f], s[f]);
    if (s.rating != null) ratings.push(s.rating);
    // 前月比は両月に値があるサイトだけで比べる（片方だけのサイトで増減を作らない）
    if (s.pv != null && s.prevPv != null) { pvComparable = add(pvComparable, s.pv); prevPvComparable = add(prevPvComparable, s.prevPv); }
    t.lastUpdatedAt = maxIso([t.lastUpdatedAt, s.lastUpdatedAt]);
  }
  return { ...t, ...change(pvComparable, prevPvComparable), rating: ratings.length ? round2(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null, ratingSites: ratings.length };
}

// stores: DBの行（id, name, sort_order）、sites: store_sites の行。observed: データに現れた店舗コード。
/** @param {{ stores: any[], sites: any[], monthly?: any[], current?: any[], currentMonth: string, month?: string|null, observed?: {source:string,key:string}[] }} input */
export function buildOverview({ stores, sites, monthly = [], current = [], currentMonth, month: requested, observed = [] }) {
  const month = referenceMonth(monthly, currentMonth, requested);
  const prev = previousMonth(month);
  const seen = [...observed, ...monthly.map((m) => ({ source: m.source, key: m.key ?? "" })), ...current.map((c) => ({ source: c.source, key: c.key ?? "" }))];
  const ctx = { monthly, current, month, prev };
  const row = (id, name, sortOrder, keys) => {
    const siteMap = {};
    for (const source of STORE_SOURCES) if (keys[source]?.size) siteMap[source] = siteAggregate(source, keys[source], ctx);
    return { id, name, sortOrder, sites: siteMap, totals: totalsOf(Object.values(siteMap)) };
  };
  const rows = sortStores(stores).map((s) => row(s.id, s.name, s.sort_order ?? 0, keysForStore(s.id, sites)));
  const loose = unassignedKeys(sites, seen);
  const unassigned = Object.keys(loose).length ? row(UNASSIGNED, UNASSIGNED_NAME, Number.MAX_SAFE_INTEGER, loose) : null;
  const all = [...rows, ...(unassigned ? [unassigned] : [])];
  const sourcesWithData = STORE_SOURCES.filter((source) => all.some((r) => r.sites[source]));
  const perSite = Object.fromEntries(sourcesWithData.map((source) => [source, totalsOf(all.map((r) => r.sites[source]).filter(Boolean))]));
  return { month, prevMonth: prev, sources: sourcesWithData, stores: rows, unassigned, totals: { ...totalsOf(all.flatMap((r) => Object.values(r.sites))), sites: perSite } };
}

// 画面の表の並び替え（null は常に末尾）
export function sortOverviewRows(rows, column, direction = "desc") {
  // column: "name" / "sortOrder" / 合計の項目（"pv" など）/ サイト別の項目（"ikyu:pv" など）
  const [site, field] = column.includes(":") ? column.split(":") : [null, column];
  const value = (r) => (column === "name" ? r.name : column === "sortOrder" ? r.sortOrder : (site ? r.sites?.[site]?.[field] : r.totals?.[field]) ?? null);
  const dir = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a), y = value(b);
    if (x == null && y == null) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "ja") * dir;
    return (x - y) * dir || (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  });
}

// 資格情報・依頼・自動取得の設定を店舗で絞り込む（rows: { source, storeKey | storeId }）
export function filterByStore(rows, keys, keyOf = (r) => r.storeKey ?? r.storeId ?? "") {
  return keys ? rows.filter((r) => inScope(keys, r.source, keyOf(r))) : rows;
}

// 店舗×サイトの表示名（店舗マスタの名前。未割り当ては店舗コード）
export function storeLabelFor(stores, sites, source, key) {
  const id = storeFor(buildSiteIndex(sites), source, key ?? "");
  const store = id ? stores.find((s) => s.id === id) : null;
  if (store) return store.name;
  return key ? `${UNASSIGNED_NAME}（${key}）` : `${UNASSIGNED_NAME}（既定）`;
}
