// エージェント側（Grok Bot）専用: 一休.comレストランの公開ページ（保存HTML）から評価・口コミ数・口コミを読む。
// アプリ（Edge Functions・ブラウザ）からは使わない。ネットワークには接続しない（PR #11 の読み取り規則を移設）。

const STORE_ID = /^[1-9][0-9]{5}$/;

function decode(value) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function prop(block, name) {
  const content = block.match(new RegExp(`itemProp="${name}"[^>]*content="([^"]*)"`, "i"));
  if (content) return decode(content[1]);
  const text = block.match(new RegExp(`itemProp="${name}"[^>]*>([\\s\\S]*?)</`, "i"));
  return text ? decode(text[1]) : "";
}

function isoDate(value) {
  const match = value.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isFinite(Date.parse(date)) ? date : null;
}

export function parseIkyuPublic(storeId, storeHtml, reviewsHtml) {
  if (!STORE_ID.test(storeId)) throw new Error("店舗IDは6桁の数字です");
  const ratingText = prop(storeHtml, "ratingValue");
  const countText = prop(storeHtml, "reviewCount");
  const rating = ratingText === "" ? null : Number(ratingText);
  const reviews = countText === "" ? null : Number(countText);
  const items = [];
  const seen = new Set();
  for (const block of reviewsHtml.split('itemType="https://schema.org/Review"').slice(1)) {
    const user = block.match(/\/reviews\/user\/([0-9a-f]{8,64})\//i)?.[1]?.toLowerCase() ?? "";
    if (!user || seen.has(user)) continue;
    seen.add(user);
    const score = Number(prop(block, "ratingValue"));
    const text = prop(block, "reviewBody");
    const author = prop(block, "name") || "匿名";
    const date = isoDate(prop(block, "datePublished"));
    if (!text || !Number.isFinite(score) || !date) continue;
    items.push({
      externalId: `I${storeId}:${user}`,
      author: author.slice(0, 300),
      rating: score,
      text: text.slice(0, 50000),
      date,
      details: { textComplete: true, origin: "public" },
    });
  }
  return {
    rating: Number.isFinite(rating) ? rating : null,
    reviews: Number.isInteger(reviews) ? reviews : null,
    items,
  };
}

// 公開ページ（店舗トップ＋口コミ一覧の各ページ）→ 取り込みJSONの stores[].public
// 例: { rating: 4.38, reviewCount: 2, reviews: [{ externalId: "I112789:305ca…", author, rating, text, date }] }
export function buildIkyuPublic(storeId, storeHtml, reviewPages = []) {
  const top = parseIkyuPublic(storeId, storeHtml, "");
  const items = new Map();
  for (const html of reviewPages) {
    for (const item of parseIkyuPublic(storeId, "", html).items) {
      if (!items.has(item.externalId)) items.set(item.externalId, { externalId: item.externalId, author: item.author, rating: item.rating, text: item.text, date: item.date });
    }
  }
  return { rating: top.rating, reviewCount: top.reviews, reviews: [...items.values()] };
}
