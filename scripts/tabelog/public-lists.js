// 食べログ公開エリア×ジャンル一覧（評価順・ニューオープン順）の読み取り。
// 広告枠を除いた掲載順。各関数は document だけを読む自己完結関数（page.evaluate にそのまま渡せる）。
// モジュール内の補助関数を参照すると page.evaluate でシリアライズされず ReferenceError になるため、
// 補助処理は関数内に置く（2026-10-05 live HTML で確認）。
// 実画面（2026-10）: カード = div.list-rst.js-rst-cassette-wrap[data-rst-id]、店名 a.list-rst__rst-name-target、
// 点数 .list-rst__rating-val、口コミ人数 em.list-rst__rvw-count-num、保存人数 .list-rst__save-count-num、
// 予算 li.list-rst__info-item > i.c-rating-v3__time--dinner|--lunch + .c-rating-v3__val、
// 駅・ジャンル .list-rst__area-genre（「新宿西口駅 235m / バー、ビストロ」）、オープン日 p.list-rst__newopen（「2026年7月1日オープン」）。
// 外側の div.js-rstlist-info は全カードの入れ物、内側にも [data-rst-id] がある（口コミ者リンク等）ため、カードだけ選び店舗IDで重複除去する。

/** 評価順（またはデフォルト並び）の有機掲載。広告スキップ。 */
export function readPublicGenreRanking({ selfStoreId = null, limit = 20 } = {}) {
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const storeIdFromHref = (href) => String(href ?? "").match(/\/(\d{8})\/?(?:[?#]|$)/)?.[1] ?? null;
  const isAdSlot = (el) => {
    if (!el) return true;
    if (el.matches?.(".list-rst--promoted, .list-rst--pr, .js-bookmark-pr, [data-is-pr='true']")) return true;
    const t = clean(el.textContent);
    if (/\bPR\b|プロモーション|広告/.test(t) && t.length < 80) return true;
    return !!el.querySelector?.(".c-badge-pr, .list-rst__pr-badge, .js-pr-badge");
  };
  const count = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/(\d+)/); return m ? Number(m[1]) : null; };
  const budget = (el, kind) => {
    const icon = el.querySelector?.(`.c-rating-v3__time--${kind}`);
    const item = icon?.closest?.(".list-rst__info-item, li, p") ?? icon?.parentElement;
    const val = clean(item?.querySelector?.(".c-rating-v3__val")?.textContent);
    return /[¥￥]\s*\d/.test(val) ? val.replace(/￥/g, "¥").replace(/[〜～]/g, "–").replace(/\s+/g, "") : null;
  };
  const readCard = (el) => {
    const link = el.querySelector("a.list-rst__rst-name-target, a.cpy-rst-name, h3 a, .list-rst__rst-name a");
    const href = link?.href ?? el.querySelector("a[href*='tabelog.com']")?.href ?? "";
    const attrId = el.getAttribute?.("data-rst-id");
    const storeId = /^\d{8}$/.test(attrId ?? "") ? attrId : storeIdFromHref(href);
    if (!storeId) return null;
    const name = clean(link?.textContent ?? el.querySelector(".list-rst__rst-name")?.textContent);
    const ratingText = clean(el.querySelector(".list-rst__rating-val, .c-rating__val, .c-rating-v2__val")?.textContent).replace(/,/g, "");
    const rating = /^\d+(?:\.\d+)?$/.test(ratingText) && Number(ratingText) <= 5 ? Number(ratingText) : null;
    const reviews = count(el.querySelector(".list-rst__rvw-count-num, .cpy-review-count, .list-rst__rvw-count em, .list-rst__rvw-count")?.textContent);
    const saveCount = count(el.querySelector(".list-rst__save-count-num")?.textContent);
    const area = clean(el.querySelector(".list-rst__area-genre, .cpy-area-genre")?.textContent) || null;
    const station = area && area.includes(" / ") ? clean(area.split(" / ")[0]) || null : null;
    return { storeId, name: name || null, rating, reviews, saveCount, budgetNight: budget(el, "dinner"), budgetDay: budget(el, "lunch"), station, areaSnippet: area, href: String(href).split("?")[0] };
  };
  let cards = [...document.querySelectorAll(".list-rst[data-rst-id], .js-rst-cassette-wrap")];
  if (!cards.length) cards = [...document.querySelectorAll(".list-rst, [data-rst-id]")];
  const entries = [];
  const seen = new Set();
  let organicRank = 0;
  let selfRank = null;
  for (const el of cards) {
    if (isAdSlot(el)) continue;
    const card = readCard(el);
    if (!card || seen.has(card.storeId)) continue;
    seen.add(card.storeId);
    organicRank += 1;
    if (selfStoreId && card.storeId === String(selfStoreId)) selfRank = organicRank;
    if (entries.length < limit) entries.push({ rank: organicRank, ...card });
  }
  const challenged = /access denied|just a moment|captcha|アクセス制限/i.test(document.title ?? "")
    || !!document.querySelector('iframe[src*="captcha"]');
  return { sort: "rating", selfStoreId: selfStoreId ? String(selfStoreId) : null, selfRank, entries, challenged, totalOrganic: organicRank };
}

/** ニューオープン順一覧（カードの「YYYY年M月D日オープン」を読む。無ければ各店公開ページで補完） */
export function readPublicNewOpenList({ limit = 30 } = {}) {
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const storeIdFromHref = (href) => String(href ?? "").match(/\/(\d{8})\/?(?:[?#]|$)/)?.[1] ?? null;
  const isAdSlot = (el) => {
    if (!el) return true;
    if (el.matches?.(".list-rst--promoted, .list-rst--pr, .js-bookmark-pr, [data-is-pr='true']")) return true;
    const t = clean(el.textContent);
    if (/\bPR\b|プロモーション|広告/.test(t) && t.length < 80) return true;
    return !!el.querySelector?.(".c-badge-pr, .list-rst__pr-badge, .js-pr-badge");
  };
  const count = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/(\d+)/); return m ? Number(m[1]) : null; };
  const ymd = (s) => {
    const m = String(s ?? "").match(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
  };
  let cards = [...document.querySelectorAll(".list-rst[data-rst-id], .js-rst-cassette-wrap")];
  if (!cards.length) cards = [...document.querySelectorAll(".list-rst, [data-rst-id]")];
  const entries = [];
  const seen = new Set();
  for (const el of cards) {
    if (isAdSlot(el)) continue;
    const link = el.querySelector("a.list-rst__rst-name-target, a.cpy-rst-name, h3 a, .list-rst__rst-name a");
    const href = link?.href ?? el.querySelector("a[href*='tabelog.com']")?.href ?? "";
    const attrId = el.getAttribute?.("data-rst-id");
    const storeId = /^\d{8}$/.test(attrId ?? "") ? attrId : storeIdFromHref(href);
    if (!storeId || seen.has(storeId)) continue;
    seen.add(storeId);
    const name = clean(link?.textContent ?? el.querySelector(".list-rst__rst-name")?.textContent);
    const ratingText = clean(el.querySelector(".list-rst__rating-val, .c-rating__val, .c-rating-v2__val")?.textContent).replace(/,/g, "");
    const rating = /^\d+(?:\.\d+)?$/.test(ratingText) && Number(ratingText) <= 5 ? Number(ratingText) : null;
    const reviews = count(el.querySelector(".list-rst__rvw-count-num, .cpy-review-count, .list-rst__rvw-count em, .list-rst__rvw-count")?.textContent);
    const area = clean(el.querySelector(".list-rst__area-genre, .cpy-area-genre")?.textContent) || null;
    // 実画面は p.list-rst__newopen。無い場合だけ「オープン」の近くの日付（口コミ本文の日付は拾わない）
    const openNode = el.querySelector(".list-rst__newopen");
    const text = clean(el.textContent);
    const openedOn = ymd(openNode?.textContent)
      ?? ymd(text.match(/\d{4}年\d{1,2}月\d{1,2}日\s*オープン/)?.[0])
      ?? ymd(text.match(/オープン[日：:\s]*\d{4}[年/.-]\d{1,2}[月/.-]\d{1,2}/)?.[0]);
    entries.push({ storeId, name: name || null, rating, reviews, areaSnippet: area, href: String(href).split("?")[0], openedOn });
    if (entries.length >= limit) break;
  }
  const challenged = /access denied|just a moment|captcha|アクセス制限/i.test(document.title ?? "")
    || !!document.querySelector('iframe[src*="captcha"]');
  return { sort: "newopen", entries, challenged };
}
