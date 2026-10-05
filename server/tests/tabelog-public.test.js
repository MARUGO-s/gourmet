import test from "node:test";
import assert from "node:assert/strict";
import { readTabelogPublicDocument, collectTabelogPublicData } from "../../scripts/tabelog/public.js";

function read(ld, dom = {}, { bodyText = "", extraQuery = {} } = {}) {
  const previous = globalThis.document;
  globalThis.document = {
    title: "店舗 | 食べログ",
    body: { innerText: bodyText },
    querySelectorAll: (sel) => {
      if (sel === 'script[type="application/ld+json"]') return ld.map((v) => ({ textContent: typeof v === "string" ? v : JSON.stringify(v) }));
      if (sel === "tr, .rdheader-budget__item, .rstinfo-table__budget, dl") {
        return (extraQuery.budgetRows ?? []).map((t) => ({ textContent: t }));
      }
      if (sel.includes("rdheader-subinfo") || sel.includes("rstinfo-table") || sel.includes("linktree")) {
        return (extraQuery.stationNodes ?? []).map((t) => ({ textContent: t }));
      }
      if (sel.includes("rdheader-rating__info") || sel.includes("rdheader-rstinfo")) {
        return (extraQuery.infoNodes ?? []).map((t) => ({ textContent: t }));
      }
      return [];
    },
    querySelector: (selector) => {
      if (dom[selector] == null) return null;
      if (typeof dom[selector] === "object") return dom[selector];
      return { textContent: dom[selector] };
    },
  };
  try { return readTabelogPublicDocument(); } finally { globalThis.document = previous; }
}

test("reads nested restaurant aggregate and preserves two-digit precision", () => {
  const result = read([{ "@graph": [{ mainEntity: { "@type": "https://schema.org/Restaurant", aggregateRating: { ratingValue: "3.26", reviewCount: "1,049" } } }] }]);
  assert.equal(result.rating, 3.26);
  assert.equal(result.reviews, 1049);
});

test("missing or broken LD falls back to restaurant header, not arbitrary review scores", () => {
  const result = read(["invalid", { "@type": "Review", aggregateRating: { ratingValue: 5, ratingCount: 500 } }], {
    ".rdheader-rating__score-val-dtl": "3.26", ".rdheader-rating__review-target .num": "49",
  });
  assert.equal(result.rating, 3.26); assert.equal(result.reviews, 49);
});

test("missing metrics stay null; zero reviews are allowed and invalid counts rejected", () => {
  assert.equal(read([]).rating, null);
  assert.equal(read([]).reviews, null);
  assert.equal(read([], { ".rdheader-rating__review-target .num": "0" }).reviews, 0);
  assert.equal(read([], { ".rdheader-rating__review-target .num": "49.5" }).reviews, null);
  assert.equal(read([], { ".rdheader-rating__score-val-dtl": "9.99" }).rating, null);
});

test("parses save count, night/day budgets, station, and open date", () => {
  const result = read(
    [{ "@type": "Restaurant", name: "テスト食堂", aggregateRating: { ratingValue: "3.26", ratingCount: "49" } }],
    {
      ".rdheader-rating__hozon-target .num": "4,007",
      ".rdheader-budget__price": "¥8,000～¥9,999",
      ".rdheader-budget__price--lunch": "¥2,000～¥2,999",
      ".rdheader-subinfo__item-station": "曙橋駅 225m",
    },
    { bodyText: "オープン日：2019年4月1日", budgetRows: ["予算（夜） ¥8,000～¥9,999", "予算（昼） ¥2,000～¥2,999"] },
  );
  assert.equal(result.saveCount, 4007);
  assert.match(result.budgetNight, /8,000/);
  assert.match(result.budgetDay, /2,000/);
  assert.equal(result.station, "曙橋駅 225m");
  assert.equal(result.openedOn, "2019-04-01");
  assert.equal(result.diagnostics.saveCount, true);
});

test("HTTP denial does not retry or parse another endpoint; page always closes", async () => {
  let closed = false;
  const context = { newPage: async () => ({ goto: async () => ({ status: () => 403 }), close: async () => { closed = true; } }) };
  const result = await collectTabelogPublicData(context, "https://tabelog.com/tokyo/A1309/A130903/13245351/");
  assert.match(result.issue, /HTTP 403/); assert.equal(result.rating, null); assert.ok(closed);
});

test("collector rejects unexpected hosts", async () => {
  await assert.rejects(collectTabelogPublicData({}, "https://example.com/tokyo/13245351/"), /URL/);
});
