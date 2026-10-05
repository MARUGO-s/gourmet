// 食べログ: 公開店舗ページの総合点・口コミ数・保存数・予算・最寄駅の読み取り（エージェント側）。
// Self-contained so Playwright can evaluate it in the page. Never read body text,
// cookies, or authenticated HTML into logs. Only the restaurant's own header/LD.
export function readTabelogPublicDocument() {
  const number = (value, count = false) => {
    const text = String(value ?? "").trim().replaceAll(",", "");
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) && (count ? Number.isSafeInteger(n) && n >= 0 : n >= 0 && n <= 5) ? n : null;
  };
  const text = (selector) => document.querySelector(selector)?.textContent?.trim();
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  const entries = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) { value.forEach((v) => visit(v, depth + 1)); return; }
    entries.push(value);
    visit(value["@graph"], depth + 1);
    visit(value.mainEntity, depth + 1);
  };
  for (const script of scripts) {
    try { visit(JSON.parse(script.textContent || "null")); } catch { /* malformed LD */ }
  }
  const restaurant = entries.find((e) => [e["@type"]].flat().some((t) => /(?:^|\/)Restaurant$/.test(String(t))) && e.aggregateRating);
  const rating = number(restaurant?.aggregateRating?.ratingValue);
  const reviews = number(restaurant?.aggregateRating?.ratingCount ?? restaurant?.aggregateRating?.reviewCount, true);
  const domRating = number(text(".rdheader-rating__score-val-dtl") ?? text(".rdheader-rating__score-val"));
  const domReviews = number(text(".rdheader-rating__review-target .num"), true);

  // 保存数（お気に入り人数）
  const saveRaw = text(".rdheader-rating__hozon-target .num")
    ?? text("[class*='hozon'] .num")
    ?? [...document.querySelectorAll(".rdheader-rating__info, .rdheader-rating__row, .rdheader-rstinfo")].map((el) => el.textContent).find((t) => /保存/.test(t ?? ""));
  let saveCount = number(typeof saveRaw === "string" && /保存/.test(saveRaw)
    ? saveRaw.replace(/,/g, "").match(/([\d]+)(?:人)?\s*保存|保存[^\d]*([\d]+)/)?.[1]
      ?? saveRaw.replace(/,/g, "").match(/([\d]+)/)?.[1]
    : saveRaw, true);
  if (saveCount == null) {
    const m = (document.body?.innerText ?? "").replace(/,/g, "").match(/([\d]+)\s*人?\s*保存|保存\s*([\d]+)/);
    saveCount = number(m?.[1] ?? m?.[2], true);
  }

  // 予算（夜／昼）。「¥8,000～¥9,999」形式をそのままテキストで保持
  const budgetCell = (label) => {
    const rows = [...document.querySelectorAll("tr, .rdheader-budget__item, .rstinfo-table__budget, dl")];
    for (const row of rows) {
      const t = (row.textContent ?? "").replace(/\s+/g, " ");
      if (!t.includes(label)) continue;
      const m = t.match(/[¥￥][\d,]+(?:\s*[〜～\-–]\s*[¥￥]?[\d,]+)?/);
      if (m) return m[0].replace(/￥/g, "¥").replace(/[〜～]/g, "–").replace(/\s+/g, "");
    }
    return null;
  };
  const budgetNight = budgetCell("夜") ?? budgetCell("ディナー") ?? text(".rdheader-budget__price") ?? null;
  const budgetDay = budgetCell("昼") ?? budgetCell("ランチ") ?? text(".rdheader-budget__price--lunch") ?? null;

  // 最寄駅
  let station = text(".rdheader-subinfo__item-station")
    ?? text("[class*='station']")
    ?? null;
  if (!station) {
    const sub = [...document.querySelectorAll(".rdheader-subinfo__item, .rstinfo-table__data, .linktree__parent-target-text")]
      .map((el) => el.textContent?.replace(/\s+/g, " ").trim())
      .find((t) => t && /駅/.test(t) && t.length < 80);
    station = sub ?? null;
  }

  // オープン日（あれば）
  let openedOn = null;
  const openMatch = (document.body?.innerText ?? "").match(/オープン日[：:\s]*(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/);
  if (openMatch) openedOn = `${openMatch[1]}-${openMatch[2].padStart(2, "0")}-${openMatch[3].padStart(2, "0")}`;

  const reviewItems = [restaurant?.review].flat().filter(Boolean).slice(0, 10).map((review) => ({
    text: String(review.reviewBody || "").trim(), author: String(review.author?.name || "匿名"),
    rating: number(review.reviewRating?.ratingValue),
  })).filter((review) => review.text && review.rating != null);
  const title = document.title ?? "";
  const challenged = /access denied|just a moment|captcha|アクセス制限|アクセスが制限/i.test(title)
    || !!document.querySelector('iframe[src*="captcha"], input[autocomplete="one-time-code"]');
  return {
    name: restaurant?.name ? String(restaurant.name) : text(".display-name"),
    rating: rating ?? domRating,
    reviews: reviews ?? domReviews,
    saveCount,
    budgetNight,
    budgetDay,
    station,
    openedOn,
    reviewItems,
    diagnostics: {
      scripts: scripts.length,
      structuredRating: rating != null,
      structuredReviews: reviews != null,
      domRating: domRating != null,
      domReviews: domReviews != null,
      saveCount: saveCount != null,
      budgets: budgetNight != null || budgetDay != null,
      challenged,
    },
  };
}

export async function collectTabelogPublicData(context, url) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== "tabelog.com" || !/^\/[^?#]+\/\d{8}\/$/.test(target.pathname)) throw new Error("公開店舗URLが不正です");
  const page = await context.newPage();
  try {
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    const status = response?.status() ?? 0;
    if (status !== 200) {
      return {
        url: target.href, rating: null, reviews: null, saveCount: null, budgetNight: null, budgetDay: null, station: null, openedOn: null,
        reviewItems: [], issue: `公開ページがHTTP ${status}を返しました。サイト側のアクセス制限や障害をご確認ください`, diagnostics: { status },
      };
    }
    await page.waitForFunction(() => document.querySelector('script[type="application/ld+json"], .rdheader-rating__score-val, iframe[src*="captcha"]'), null, { timeout: 8000 }).catch(() => {});
    const parsed = await page.evaluate(readTabelogPublicDocument);
    const diagnostics = { status, ...parsed.diagnostics };
    if (diagnostics.challenged) {
      return {
        url: target.href, rating: null, reviews: null, saveCount: null, budgetNight: null, budgetDay: null, station: null, openedOn: null,
        reviewItems: [], issue: "公開ページに追加認証またはアクセス制限が表示されています。制限は回避せず停止しました", diagnostics,
      };
    }
    const issue = parsed.rating == null || parsed.reviews == null
      ? `公開ページの評価・口コミ数が見つかりません（HTTP ${status}、構造化データ ${diagnostics.scripts}件）` : undefined;
    return { url: target.href, ...parsed, diagnostics, issue };
  } finally { await page.close(); }
}
