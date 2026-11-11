// 食べログ公開ページの読み取り結果 → 管理画面の日別・月別を含まない取り込み用 result / payload。
// 公開レポート（public_profile / public_genre_ranking / public_competitors / public_new_opens）だけを載せる。
import { tabelogResultToPayload } from "./payload.js";
import { storePublicConfig } from "./store-config.js";

export const PUBLIC_ONLY_WARNING = "公開ページ（自店・ジャンル順位・ニューオープン）のみ。管理画面の日別・月別は含みません";

export const PUBLIC_FETCH_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_DELAY_MS = 2500;

/** HTTP 応答または HTML がアクセス制限・CAPTCHA なら理由、そうでなければ null。回避はしない。 */
export function isBlockedPublicPage({ status = 0, html = "", title = "" } = {}) {
  if ([403, 429, 503].includes(Number(status))) return `HTTP ${status}`;
  const head = `${title}\n${String(html).slice(0, 8000)}`;
  if (/just a moment|cf-browser-verification|challenge-platform|attention required|access denied|captcha|アクセス制限/i.test(head)) {
    return "追加認証またはアクセス制限";
  }
  return null;
}

/** ジャンル指定が無視された一覧（全ジャンルの「おすすめ」） */
export function isIgnoredGenreList(title) {
  return /おすすめのグルメ情報/.test(String(title ?? ""));
}

export function pageTitle(html) {
  const m = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * @param {{ self?: object, rankings?: object[], opens?: object[], storeKey: string, competitorCap?: number, warning?: string }} parsed
 * rankings / opens は areaKey, genreKey, area, genre, url, entries（評価順は selfRank, totalOrganic）を持つ。
 */
export function buildPublicOnlyResult({ self, rankings = [], opens = [], storeKey, competitorCap, warning } = {}) {
  const cap = competitorCap ?? storePublicConfig(storeKey)?.competitorCap ?? 5;
  const home = rankings[0] ?? null;
  const own = home?.entries?.find((e) => String(e.storeId) === String(storeKey));
  const competitors = home
    ? [
      ...home.entries.filter((e) => String(e.storeId) !== String(storeKey)).slice(0, cap),
      ...(own ? [{ ...own, own: true }] : []),
    ]
    : [];
  const d = self ?? {};
  return {
    status: "partial",
    warning: warning ?? PUBLIC_ONLY_WARNING,
    data: {
      rating: d.rating ?? null,
      reviews: d.reviews ?? null,
      saveCount: d.saveCount ?? null,
      budgetNight: d.budgetNight ?? null,
      budgetDay: d.budgetDay ?? null,
      station: d.station ?? null,
      openedOn: d.openedOn ?? null,
    },
    daily: [],
    monthly: [],
    reviews: [],
    reports: {
      publicGenreRankings: rankings,
      ...(home ? { publicCompetitors: { area: home.area, genre: home.genre, entries: competitors } } : {}),
      publicNewOpens: opens,
    },
  };
}

export function buildPublicOnlyPayload({ self, rankings, opens, storeKey, competitorCap, warning, name, publicUrl, runId, agent, capturedAt, requestId, today }) {
  const result = buildPublicOnlyResult({ self, rankings, opens, storeKey, competitorCap, warning });
  const payload = tabelogResultToPayload(result, { storeKey, name, publicUrl, runId, agent, capturedAt, requestId, today });
  return { result, payload };
}
