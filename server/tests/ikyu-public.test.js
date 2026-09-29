import test from "node:test";
import assert from "node:assert/strict";
import { parseIkyuPublic } from "../ikyu-public.js";
import { validateIkyuResult } from "../sync-data.js";

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
  const result = {
    status: "partial",
    warning: "公開ページの評価と口コミを保存しました。PVと予約数は未取得です。",
    data: { rating: parsed.rating, reviews: parsed.reviews, pv: null, reservations: null },
    reviews: parsed.items,
    daily: [],
    monthly: [],
  };
  assert.doesNotThrow(() => validateIkyuResult(result));
});

test("a short store id is rejected", () => {
  assert.throws(() => parseIkyuPublic("12345", storeHtml, reviewsHtml), /6桁/);
});
