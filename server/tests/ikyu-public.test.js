import test from "node:test";
import assert from "node:assert/strict";
import { buildIkyuPublic, parseIkyuPublic } from "../../scripts/ikyu/public.js";
import { buildIkyuPayload } from "../../scripts/ikyu/parse.js";
import { dropPublicDuplicates, normalizeIkyuIngest } from "../../supabase/functions/_shared/ikyu-data.js";

const storeHtml = `
<div itemProp="aggregateRating">
  <div itemProp="ratingValue">4.38</div>
  （<span itemProp="reviewCount">2</span>件）
</div>
<div itemProp="ratingValue">9.99</div>
`;
const reviewsHtml = `
<article itemProp="review" itemType="https://schema.org/Review">
  <a href="/reviews/user/305ca13a07989a902773/">link</a>
  <span itemProp="name">ぎん３</span>
  <span itemProp="datePublished">2026/08/23</span>
  <span itemProp="ratingValue">5.0</span>
  <p itemProp="reviewBody">初めて利用しました。</p>
</article>
<article itemProp="review" itemType="https://schema.org/Review">
  <a href="/reviews/user/792bcd565f4ea4bbe59f/">link</a>
  <span itemProp="name">ハセカジ</span>
  <meta itemProp="datePublished" content="2026-08-02">
  <span itemProp="ratingValue">4.5</span>
  <p itemProp="reviewBody">家族で美味しくいただきました。</p>
</article>
`;

test("public ikyu page yields the store score and review posts", () => {
  const parsed = parseIkyuPublic("112789", storeHtml, reviewsHtml);
  assert.equal(parsed.rating, 4.38);
  assert.equal(parsed.reviews, 2);
  assert.deepEqual(parsed.items.map((item) => item.externalId), [
    "I112789:305ca13a07989a902773",
    "I112789:792bcd565f4ea4bbe59f",
  ]);
  assert.equal(parsed.items[1].date, "2026-08-02");
  // 取り込みJSON（stores[].public）にしても agent-api と同じ検証を通る
  const pub = buildIkyuPublic("112789", storeHtml, [reviewsHtml, reviewsHtml]);
  assert.equal(pub.reviews.length, 2);
  const checked = normalizeIkyuIngest(buildIkyuPayload({ runId: "ikyu-public-1", stores: [{ storeId: "112789", public: pub }] }), "2026-09-29");
  assert.equal(checked.stores[0].public.rating, 4.38);
  assert.equal(checked.stores[0].public.review_count, 2);
  assert.equal(checked.stores[0].public.reviews[0].external_id, "I112789:305ca13a07989a902773");
});

test("a short store id is rejected", () => {
  assert.throws(() => parseIkyuPublic("12345", storeHtml, reviewsHtml), /6桁/);
});

test("public reviews must belong to the store and stay in range", () => {
  const payload = (pub) => buildIkyuPayload({ runId: "r1", stores: [{ storeId: "112789", public: pub }] });
  const review = { externalId: "I112789:305ca13a07989a902773", author: "a", rating: 4.5, text: "美味しい", date: "2026-08-01" };
  assert.throws(() => normalizeIkyuIngest(payload({ reviews: [{ ...review, externalId: "I999999:305ca13a07989a902773" }] }), "2026-09-29"), /externalId/);
  assert.throws(() => normalizeIkyuIngest(payload({ rating: 5.1 }), "2026-09-29"), /0〜5/);
  assert.throws(() => normalizeIkyuIngest(payload({ reviews: [review, review] }), "2026-09-29"), /重複/);
  assert.throws(() => normalizeIkyuIngest(payload({}), "2026-09-29"), /保存できるデータがありません/);
  assert.equal(normalizeIkyuIngest(payload({ rating: 4.2 }), "2026-09-29").stores[0].public.reviews.length, 0);
});

test("public Ikyu reviews that match an owner-console review are shown once", () => {
  const legacy = [{ source: "ikyu", text: "美味しい 料理" }, { source: "ikyu", text: "別の口コミ" }, { source: "tabelog", text: "美味しい料理" }];
  const kept = dropPublicDuplicates(legacy, [{ text: "美味しい料理" }]);
  assert.deepEqual(kept.map((r) => r.text), ["別の口コミ", "美味しい料理"]);
});
