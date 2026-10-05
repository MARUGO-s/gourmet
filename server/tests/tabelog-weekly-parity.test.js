import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReservationNotices } from "../../scripts/tabelog/owner-home.js";
import { readPublicGenreRanking, readPublicNewOpenList } from "../../scripts/tabelog/public-lists.js";
import { publicFetchPlan, storePublicConfig } from "../../scripts/tabelog/store-config.js";
import { weeklyPvWindows, sumDailyPv, pctChange, within30Days } from "../../scripts/tabelog/weekly-windows.js";
import { assembleWeeklyReportInput, buildWeeklyReportHtml } from "../../scripts/tabelog/weekly-report.js";
import { tabelogResultToPayload } from "../../scripts/tabelog/payload.js";
import { normalizeSourceIngest } from "../../supabase/functions/_shared/source-ingest.js";
import { PAGE_CATALOG, PUBLIC_FETCH_CATALOG, routinePageList } from "../../supabase/functions/_shared/page-snapshots.js";
import { AI_TOOLS, runTool } from "../../supabase/functions/_shared/ai-analyst.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(__dir, "fixtures/tabelog", name), "utf8");

function withDocument(html, fn) {
  // Minimal DOM for evaluate-style readers using regex-free structure from fixtures via linkedom-less stub:
  // Use a tiny HTML parser via undici? Prefer playwright-free: implement querySelector over a fake tree from regex.
  // Instead: inject via jsdom alternative — Node 22 has no DOM. Use recursive regex extractors for tests of pure functions
  // by evaluating against a hand-built document mock matching fixture structure.
  const previous = globalThis.document;
  const parseSimple = (src) => {
    // Extremely small DOM: only what our readers need.
    const elements = [];
    const pushEl = (tag, attrs, text, htmlInner, children = []) => {
      const el = {
        tagName: tag.toUpperCase(),
        textContent: text,
        innerText: text,
        children,
        className: attrs.class || "",
        href: attrs.href,
        attributes: attrs,
        getAttribute: (k) => attrs[k] ?? null,
        matches: (sel) => {
          if (sel.includes("list-rst--promoted") && /\blist-rst--promoted\b/.test(attrs.class || "")) return true;
          if (sel.includes("data-is-pr") && attrs["data-is-pr"] === "true") return true;
          return false;
        },
        querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
        querySelectorAll: (sel) => {
          const out = [];
          const walk = (node) => {
            if (matchSel(node, sel)) out.push(node);
            for (const c of node.children || []) walk(c);
          };
          walk(el);
          return out;
        },
        parentElement: null,
        nextElementSibling: null,
      };
      for (const c of children) c.parentElement = el;
      for (let i = 0; i < children.length - 1; i++) children[i].nextElementSibling = children[i + 1];
      elements.push(el);
      return el;
    };
    const matchSel = (node, sel) => {
      if (sel.startsWith(".")) return (node.className || "").split(/\s+/).includes(sel.slice(1).split(".")[0]) || (node.className || "").includes(sel.replace(/\./g, " ").trim().split(/\s+/)[0]);
      if (sel.includes("a.list-rst__rst-name-target") || sel === "a.list-rst__rst-name-target, a.cpy-rst-name, h3 a, .list-rst__rst-name a") {
        return node.tagName === "A" && /list-rst__rst-name-target/.test(node.className || "");
      }
      if (sel.includes("list-rst__rating-val")) return /list-rst__rating-val/.test(node.className || "");
      if (sel.includes("list-rst__rvw-count")) return /list-rst__rvw-count/.test(node.className || "");
      if (sel.includes("c-badge-pr")) return /c-badge-pr|list-rst__pr-badge|js-pr-badge/.test(node.className || "");
      if (sel.startsWith("[data-notice")) {
        const m = sel.match(/data-notice="(\w+)"/);
        return m && node.getAttribute("data-notice") === m[1];
      }
      if (sel.includes("iframe")) return false;
      return false;
    };
    // Owner-home notices
    if (/data-notice=/.test(src)) {
      const items = [];
      for (const m of src.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)) {
        const attrs = {};
        for (const a of m[1].matchAll(/(\w[\w-]*)="([^"]*)"/g)) attrs[a[1]] = a[2];
        const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        items.push(pushEl("li", attrs, text, m[2]));
      }
      const body = pushEl("body", {}, src.replace(/<[^>]+>/g, " "), src, items);
      return {
        title: src.match(/<title>([^<]*)/)?.[1] ?? "",
        body,
        querySelectorAll: (sel) => {
          if (sel.includes("a, button")) return items;
          return items.filter((el) => matchSel(el, sel) || true).filter((el) => {
            // For generic node list used by pick(), return all items
            return true;
          });
        },
        querySelector: (sel) => {
          if (sel.includes('iframe')) return null;
          const key = sel.match(/data-notice="(\w+)"/)?.[1];
          if (key) return items.find((el) => el.getAttribute("data-notice") === key) ?? null;
          return null;
        },
      };
    }
    // Ranking / newopen cards
    const cards = [];
    for (const m of src.matchAll(/<div class="(list-rst[^"]*)"[^>]*>([\s\S]*?)<\/div>/g)) {
      const className = m[1];
      const inner = m[2];
      const href = inner.match(/href="([^"]+)"/)?.[1];
      const name = inner.match(/>([^<]+)<\/a>/)?.[1]?.trim();
      const rating = inner.match(/list-rst__rating-val[^>]*>([^<]+)/)?.[1];
      const reviews = inner.match(/<em>([^<]+)<\/em>/)?.[1];
      const children = [];
      if (href) children.push(pushEl("a", { class: "list-rst__rst-name-target", href }, name, name));
      if (rating) children.push(pushEl("span", { class: "list-rst__rating-val" }, rating, rating));
      if (reviews) {
        const em = pushEl("em", {}, reviews, reviews);
        children.push(pushEl("span", { class: "list-rst__rvw-count" }, `${reviews}件`, `${reviews}件`, [em]));
      }
      if (/list-rst--promoted|c-badge-pr/.test(className + inner)) {
        children.push(pushEl("span", { class: "c-badge-pr" }, "PR", "PR"));
      }
      // open date text node on card itself
      const card = pushEl("div", { class: className }, inner.replace(/<[^>]+>/g, " "), inner, children);
      cards.push(card);
    }
    return {
      title: src.match(/<title>([^<]*)/)?.[1] ?? "",
      body: { innerText: src.replace(/<[^>]+>/g, " ") },
      querySelectorAll: (sel) => {
        if (sel.includes("list-rst")) return cards;
        return [];
      },
      querySelector: (sel) => (sel.includes("iframe") ? null : null),
    };
  };
  globalThis.document = parseSimple(html);
  try { return fn(); } finally { globalThis.document = previous; }
}

test("owner-home parser returns counts only (ignores guest names)", () => {
  const result = withDocument(fixture("owner-home.html"), () => readReservationNotices());
  assert.deepEqual({ new: result.new, changed: result.changed, cancelled: result.cancelled }, { new: 1, changed: 2, cancelled: 1 });
  assert.equal(result.found, true);
  assert.ok(!JSON.stringify(result).includes("山田"));
});

test("public genre ranking skips PR/ad slots and finds self rank", () => {
  const result = withDocument(fixture("rank-genre.html"), () => readPublicGenreRanking({ selfStoreId: "13245351", limit: 10 }));
  assert.equal(result.entries[0].name, "ラトラスフィス");
  assert.equal(result.entries[0].rank, 1);
  assert.equal(result.selfRank, 3);
  assert.ok(!result.entries.some((e) => /広告/.test(e.name)));
});

test("public new-open list reads openedOn when present", () => {
  const result = withDocument(fixture("newopen.html"), () => readPublicNewOpenList({ limit: 10 }));
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].openedOn, "2026-08-27");
});

test("public list readers are self-contained for page.evaluate (no module-scope helpers)", () => {
  // page.evaluate はソース文字列だけを送る。モジュール外の関数を参照すると実ブラウザで ReferenceError になる（2026-10-05 live で発生）。
  const isolated = (fn) => new Function(`return (${fn.toString()});`)();
  const ranking = withDocument(fixture("rank-genre.html"), () => isolated(readPublicGenreRanking)({ selfStoreId: "13245351", limit: 10 }));
  assert.equal(ranking.entries[0].name, "ラトラスフィス");
  assert.equal(ranking.selfRank, 3);
  const opens = withDocument(fixture("newopen.html"), () => isolated(readPublicNewOpenList)({ limit: 10 }));
  assert.equal(opens.entries[0].openedOn, "2026-08-27");
  const owner = withDocument(fixture("owner-home.html"), () => isolated(readReservationNotices)());
  assert.equal(owner.found, true);
});

test("store config for CAVA exposes areas/genres and fetch plan URLs", () => {
  const cfg = storePublicConfig("13245351");
  assert.equal(cfg.name, "BISTRO CAVA CAVA");
  assert.ok(cfg.areas.some((a) => /曙橋|四ツ谷/.test(a.areaLabel)));
  assert.deepEqual(cfg.genres.map((g) => g.slug).sort(), ["BC0103", "bistro", "french"]);
  assert.deepEqual(cfg.areas.map((a) => a.path), ["tokyo/A1309/A130903", "tokyo/A1309/A130902", "tokyo/A1309/A130904"]);
  const plan = publicFetchPlan("13245351");
  assert.ok(plan.pages.some((p) => p.page === "tabelog_public_store"));
  assert.ok(plan.pages.every((p) => p.url.startsWith("https://tabelog.com/")));
  assert.ok(plan.pages.some((p) => p.page === "tabelog_public_rank_newopen"));
});

test("weekly PV windows and pct helpers", () => {
  const w = weeklyPvWindows("2026-10-05");
  assert.deepEqual(w.last7, { from: "2026-09-28", to: "2026-10-04" });
  assert.deepEqual(w.prior7, { from: "2026-09-21", to: "2026-09-27" });
  const daily = [];
  for (let i = 0; i < 14; i++) daily.push({ date: ["2026-09-21","2026-09-22","2026-09-23","2026-09-24","2026-09-25","2026-09-26","2026-09-27","2026-09-28","2026-09-29","2026-09-30","2026-10-01","2026-10-02","2026-10-03","2026-10-04"][i], pv: 10 });
  assert.equal(sumDailyPv(daily, w.last7.from, w.last7.to).pv, 70);
  assert.equal(pctChange(70, 70), 0);
  assert.equal(within30Days("2026-09-10", "2026-10-05"), true);
  assert.equal(within30Days("2026-08-01", "2026-10-05"), false);
});

test("payload includes public_profile and reservation_notices; ingest accepts them", () => {
  const result = {
    status: "partial",
    warning: "テスト用",
    data: { rating: 3.26, reviews: 49, saveCount: 4007, budgetNight: "¥8,000–¥9,999", budgetDay: "¥2,000–¥2,999", station: "曙橋駅 225m" },
    daily: [{ date: "2026-09-28", pv: 10, pc: 2, sp: 3, app: 5 }],
    monthly: [{ month: "2026-09", pv: 100, pc: 20, sp: 30, app: 50, reservations: 14, calls: 5 }],
    reviews: [],
    reports: {
      reservationNotices: { new: 1, changed: 2, cancelled: 1, capturedAt: "2026-10-05T12:00:00+09:00" },
      publicGenreRankings: [{ areaKey: "a", genreKey: "bistro", area: "曙橋", genre: "ビストロ", selfRank: 8, entries: [] }],
      publicCompetitors: { area: "曙橋", entries: [{ name: "X", rating: 3.5, reviews: 10, own: false }] },
      publicNewOpens: [{ areaKey: "a", genreKey: "bistro", entries: [{ name: "Y", openedOn: "2026-09-01" }] }],
    },
  };
  const payload = tabelogResultToPayload(result, { storeKey: "13245351", name: "BISTRO CAVA CAVA", today: "2026-10-05", capturedAt: "2026-10-05T12:00:00+09:00" });
  const kinds = payload.stores[0].reports.map((r) => r.kind);
  assert.ok(kinds.includes("public_profile"));
  assert.ok(kinds.includes("reservation_notices"));
  assert.ok(kinds.includes("public_genre_ranking"));
  assert.ok(kinds.includes("public_competitors"));
  assert.ok(kinds.includes("public_new_opens"));
  assert.equal(payload.stores[0].summary.saveCount, 4007);
  const n = normalizeSourceIngest(payload, "2026-10-05");
  assert.ok(n.stores[0].reports.some((r) => r.kind === "public_profile"));
});

test("page catalog includes owner home (pii raw); public fetch catalog documented", () => {
  const home = PAGE_CATALOG.tabelog.find((p) => p.page === "tabelog_owner_home");
  assert.ok(home);
  assert.equal(home.pii, true);
  assert.equal(home.status, "raw");
  assert.ok(routinePageList("tabelog", "13245351").some((p) => p.page === "tabelog_owner_home"));
  assert.ok(PUBLIC_FETCH_CATALOG.some((p) => p.page === "tabelog_public_store"));
  assert.ok(PUBLIC_FETCH_CATALOG.every((p) => p.host === "tabelog.com"));
});

test("weekly HTML generator embeds offline CSS and sections", () => {
  const input = assembleWeeklyReportInput({
    storeKey: "13245351", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05",
    monthlyRows: [
      { month: "2026-08", pv: 4624, reservations: 15, calls: 11, pvPc: 988, pvSp: 481, pvApp: 3155 },
      { month: "2026-09", pv: 4753, reservations: 14, calls: 5, pvPc: 1017, pvSp: 499, pvApp: 3237 },
    ],
    dailyRows: Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 5 + i));
      return { date: d.toISOString().slice(0, 10), pv: 100 + (i % 7) * 10 };
    }),
    publicProfile: { rating: 3.26, reviewCount: 49, saveCount: 4007, budgetNight: "¥8,000–¥9,999", budgetDay: "¥2,000–¥2,999" },
    notices: { new: 1, changed: 2, cancelled: 1 },
    accessRanking: { area: "曙橋・四ツ谷三丁目", self: { rank: 128, pv: 4753 }, momPct: 3 },
    competitors: [
      { name: "ラトラスフィス", rating: 3.61, reviews: 146, budgetNight: "¥8,000–¥9,999", budgetDay: "¥5,000–¥5,999", station: "四谷三丁目駅", saveCount: 8857 },
      { name: "BISTRO CAVA CAVA", rating: 3.26, reviews: 49, budgetNight: "¥8,000–¥9,999", budgetDay: "¥2,000–¥2,999", station: "曙橋駅", saveCount: 4007, own: true },
    ],
    genreRanks: [{ label: "ビストロ ランキング", rank: 8 }],
    newOpens: [{ areaLabel: "曙橋・四ツ谷三丁目", name: "おむすびJazz Club Tokyo", genreLabel: "フレンチ", openedOn: "2026-08-27" }],
  });
  const html = buildWeeklyReportHtml(input);
  assert.match(html, /【食べログ週報】BISTRO CAVA CAVA/);
  assert.match(html, /表2/);
  assert.match(html, /保存数/);
  assert.match(html, /通話成立≠予約確定/);
  assert.match(html, /ラトラスフィス/);
  assert.ok(!html.includes("http://") && !html.includes("https://cdn"), "offline: no external asset URLs in body hooks");
});

test("AI tools include weekly parity helpers", () => {
  const names = AI_TOOLS.map((t) => t.function.name);
  for (const n of ["get_weekly_pv_windows", "get_public_profile", "get_reservation_notices", "get_competitor_snapshot", "get_genre_rank", "get_area_new_opens"]) {
    assert.ok(names.includes(n), n);
  }
  const CAVA = "11111111-1111-4111-8111-111111111111";
  const ds = {
    today: "2026-10-05",
    stores: [{ id: CAVA, name: "BISTRO CAVACAVA", sort_order: 1 }],
    sites: [{ store_id: CAVA, source: "tabelog", site_store_key: "13245351" }],
    daily: [], legacy: [], monthly: [], current: [], reviews: [],
    reports: [
      { source: "tabelog", key: "13245351", kind: "public_profile", period: "2026-10-05", updatedAt: "2026-10-05T01:00:00Z", data: { saveCount: 4007, budgetNight: "¥8,000–¥9,999" } },
      { source: "tabelog", key: "13245351", kind: "reservation_notices", period: "2026-10-05", updatedAt: "2026-10-05T01:00:00Z", data: { new: 1, changed: 2, cancelled: 1 } },
    ],
    sourceDaily: [], sourceMonthly: [], ikyuDaily: [], ikyuMonthly: [], freshness: [],
  };
  const ctx = { store: CAVA, from: "2026-09-01", to: "2026-09-30" };
  const profile = JSON.parse(runTool(ds, "get_public_profile", {}, ctx));
  assert.equal(profile.profile.saveCount, 4007);
  const notices = JSON.parse(runTool(ds, "get_reservation_notices", {}, ctx));
  assert.equal(notices.notices.new, 1);
});
