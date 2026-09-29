import test from "node:test";
import assert from "node:assert/strict";
import { readTabelogPublicDocument, collectTabelogPublicData } from "../../scripts/tabelog/public.js";

function read(ld, dom = {}) {
  const previous = globalThis.document;
  globalThis.document = {
    title: "店舗 | 食べログ",
    querySelectorAll: () => ld.map(v => ({ textContent: typeof v === "string" ? v : JSON.stringify(v) })),
    querySelector: selector => dom[selector] == null ? null : { textContent: dom[selector] },
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
test("HTTP denial does not retry or parse another endpoint; page always closes", async () => {
  let closed = false;
  const context = { newPage: async () => ({ goto: async () => ({ status: () => 403 }), close: async () => { closed = true; } }) };
  const result = await collectTabelogPublicData(context, "https://tabelog.com/tokyo/A1309/A130903/13245351/");
  assert.match(result.issue, /HTTP 403/); assert.equal(result.rating, null); assert.ok(closed);
});
test("collector rejects unexpected hosts", async () => {
  await assert.rejects(collectTabelogPublicData({}, "https://example.com/tokyo/13245351/"), /URL/);
});
