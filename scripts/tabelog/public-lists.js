// 食べログ公開エリア×ジャンル一覧（評価順・ニューオープン順）の読み取り。
// 広告枠を除いた掲載順。document 自己完結（page.evaluate 用）。

function storeIdFromHref(href) {
  const m = String(href ?? "").match(/\/(\d{8})\/?(?:[?#]|$)/);
  return m ? m[1] : null;
}

function isAdSlot(el) {
  if (!el) return true;
  if (el.matches?.(".list-rst--promoted, .list-rst--pr, .js-bookmark-pr, [data-is-pr='true']")) return true;
  const t = (el.textContent ?? "").replace(/\s+/g, " ");
  if (/\bPR\b|プロモーション|広告/.test(t) && t.length < 80) return true;
  if (el.querySelector?.(".c-badge-pr, .list-rst__pr-badge, .js-pr-badge")) return true;
  return false;
}

function readCard(el) {
  const link = el.querySelector("a.list-rst__rst-name-target, a.cpy-rst-name, h3 a, .list-rst__rst-name a");
  const href = link?.href ?? el.querySelector("a[href*='tabelog.com']")?.href ?? "";
  const storeId = storeIdFromHref(href);
  if (!storeId) return null;
  const name = (link?.textContent ?? el.querySelector(".list-rst__rst-name")?.textContent ?? "").replace(/\s+/g, " ").trim();
  const ratingText = (el.querySelector(".list-rst__rating-val, .c-rating__val, .c-rating-v2__val")?.textContent ?? "").trim().replace(/,/g, "");
  const rating = /^\d+(?:\.\d+)?$/.test(ratingText) && Number(ratingText) <= 5 ? Number(ratingText) : null;
  const reviewText = (el.querySelector(".list-rst__rvw-count, .list-rst__rvw-count em, .cpy-review-count")?.textContent ?? "").replace(/,/g, "");
  const reviews = (() => {
    const m = reviewText.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  })();
  const area = (el.querySelector(".list-rst__area-genre, .cpy-area-genre")?.textContent ?? "").replace(/\s+/g, " ").trim() || null;
  return { storeId, name: name || null, rating, reviews, areaSnippet: area, href: href.split("?")[0] };
}

/** 評価順（またはデフォルト並び）の有機掲載。広告スキップ。 */
export function readPublicGenreRanking({ selfStoreId = null, limit = 20 } = {}) {
  const cards = [...document.querySelectorAll(".list-rst, .js-rstlist-info, [data-rst-id]")];
  const entries = [];
  let organicRank = 0;
  let selfRank = null;
  for (const el of cards) {
    if (isAdSlot(el)) continue;
    const card = readCard(el);
    if (!card) continue;
    organicRank += 1;
    const row = { rank: organicRank, ...card };
    if (selfStoreId && card.storeId === String(selfStoreId)) selfRank = organicRank;
    entries.push(row);
    if (entries.length >= limit) break;
  }
  const challenged = /access denied|just a moment|captcha|アクセス制限/i.test(document.title ?? "")
    || !!document.querySelector('iframe[src*="captcha"]');
  return { sort: "rating", selfStoreId: selfStoreId ? String(selfStoreId) : null, selfRank, entries, challenged, totalOrganic: organicRank };
}

/** ニューオープン順一覧（オープン日は一覧に無いことが多い → 各店公開ページで補完） */
export function readPublicNewOpenList({ limit = 30 } = {}) {
  const cards = [...document.querySelectorAll(".list-rst, .js-rstlist-info, [data-rst-id]")];
  const entries = [];
  for (const el of cards) {
    if (isAdSlot(el)) continue;
    const card = readCard(el);
    if (!card) continue;
    // 一覧にオープン表記があれば拾う
    const openText = (el.textContent ?? "").match(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/);
    const openedOn = openText
      ? `${openText[1]}-${openText[2].padStart(2, "0")}-${openText[3].padStart(2, "0")}`
      : null;
    entries.push({ ...card, openedOn });
    if (entries.length >= limit) break;
  }
  const challenged = /access denied|just a moment|captcha|アクセス制限/i.test(document.title ?? "")
    || !!document.querySelector('iframe[src*="captcha"]');
  return { sort: "newopen", entries, challenged };
}
