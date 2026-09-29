// Public restaurant page only. Owner PV and reservations stay unset:
// the store admin login requires a Cloudflare check this collector does not bypass.

const STORE_ID = /^[1-9][0-9]{5}$/;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

export async function collectIkyuPublic(storeId, fetchImpl = globalThis.fetch) {
  if (!STORE_ID.test(storeId)) throw new Error("店舗IDは6桁の数字です");
  const headers = { "Accept-Language": "ja,en;q=0.8", "User-Agent": USER_AGENT };
  const load = async (url) => {
    const response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const html = await response.text();
    return { status: response.status, html, url: response.url || url };
  };
  const store = await load(`https://restaurant.ikyu.com/${storeId}`);
  if (store.status !== 200 || !store.url.includes(`/${storeId}`)) {
    const error = new Error(store.status === 403
      ? "一休.comレストランの公開ページが取得用サーバーから拒否されました。保存済みの値は変更していません"
      : "一休.comレストランの公開ページを開けませんでした");
    error.step = "public_page";
    throw error;
  }
  const reviewsPage = await load(`https://restaurant.ikyu.com/${storeId}/reviews`);
  if (reviewsPage.status !== 200) {
    const error = new Error("一休.comレストランの口コミページを開けませんでした");
    error.step = "public_page";
    throw error;
  }
  return parseIkyuPublic(storeId, store.html, reviewsPage.html);
}
