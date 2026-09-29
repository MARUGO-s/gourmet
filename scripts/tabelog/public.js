// 食べログ: 公開店舗ページの総合点・口コミ数の読み取り（エージェント側）。
// Self-contained so Playwright can evaluate it in the page. Never read body text,
// cookies, or authenticated HTML into logs. Only the restaurant's own header/LD.
export function readTabelogPublicDocument() {
  const number = (value, count = false) => {
    const text = String(value ?? "").trim().replaceAll(",", "");
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) && (count ? Number.isSafeInteger(n) && n >= 0 : n >= 0 && n <= 5) ? n : null;
  };
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  const entries = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) { value.forEach(v => visit(v, depth + 1)); return; }
    entries.push(value);
    visit(value["@graph"], depth + 1);
    visit(value.mainEntity, depth + 1);
  };
  for (const script of scripts) {
    try { visit(JSON.parse(script.textContent || "null")); } catch { /* malformed LD */ }
  }
  const restaurant = entries.find(e => [e["@type"]].flat().some(t => /(?:^|\/)Restaurant$/.test(String(t))) && e.aggregateRating);
  const rating = number(restaurant?.aggregateRating?.ratingValue);
  const reviews = number(restaurant?.aggregateRating?.ratingCount ?? restaurant?.aggregateRating?.reviewCount, true);
  const text = selector => document.querySelector(selector)?.textContent?.trim();
  const domRating = number(text(".rdheader-rating__score-val-dtl") ?? text(".rdheader-rating__score-val"));
  const domReviews = number(text(".rdheader-rating__review-target .num"), true);
  const reviewItems = [restaurant?.review].flat().filter(Boolean).slice(0, 10).map(review => ({
    text: String(review.reviewBody || "").trim(), author: String(review.author?.name || "匿名"),
    rating: number(review.reviewRating?.ratingValue),
  })).filter(review => review.text && review.rating != null);
  const title = document.title ?? "";
  const challenged = /access denied|just a moment|captcha|アクセス制限|アクセスが制限/i.test(title)
    || !!document.querySelector('iframe[src*="captcha"], input[autocomplete="one-time-code"]');
  return {
    name: restaurant?.name ? String(restaurant.name) : text(".display-name"),
    rating: rating ?? domRating, reviews: reviews ?? domReviews, reviewItems,
    diagnostics: { scripts: scripts.length, structuredRating: rating != null, structuredReviews: reviews != null, domRating: domRating != null, domReviews: domReviews != null, challenged },
  };
}

export async function collectTabelogPublicData(context, url) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== "tabelog.com" || !/^\/[^?#]+\/\d{8}\/$/.test(target.pathname)) throw new Error("公開店舗URLが不正です");
  const page = await context.newPage();
  try {
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    const status = response?.status() ?? 0;
    if (status !== 200) return { url: target.href, rating: null, reviews: null, reviewItems: [], issue: `公開ページがHTTP ${status}を返しました。サイト側のアクセス制限や障害をご確認ください`, diagnostics: { status } };
    // LD or header can arrive after DOMContentLoaded. Bounded wait, no bypass.
    await page.waitForFunction(() => document.querySelector('script[type="application/ld+json"], .rdheader-rating__score-val, iframe[src*="captcha"]'), null, { timeout: 8000 }).catch(() => {});
    const parsed = await page.evaluate(readTabelogPublicDocument);
    const diagnostics = { status, ...parsed.diagnostics };
    if (diagnostics.challenged) return { url: target.href, rating: null, reviews: null, reviewItems: [], issue: "公開ページに追加認証またはアクセス制限が表示されています。制限は回避せず停止しました", diagnostics };
    const issue = parsed.rating == null || parsed.reviews == null
      ? `公開ページの評価・口コミ数が見つかりません（HTTP ${status}、構造化データ ${diagnostics.scripts}件）` : undefined;
    return { url: target.href, ...parsed, diagnostics, issue };
  } finally { await page.close(); }
}
