// 店舗ごとの公開エリア×ジャンル設定（週報の競合・新規オープン用）。
// storeKey（8桁）または publicUrl から引く。未登録店舗は空設定。

/** @typedef {{ areaKey: string, areaLabel: string, path: string }} AreaDef */
/** @typedef {{ genreKey: string, genreLabel: string, slug: string }} GenreDef */

/** @type {Record<string, { name: string, publicUrl: string, areas: AreaDef[], genres: GenreDef[], competitorCap: number }>} */
export const STORE_PUBLIC_CONFIG = {
  "13245351": {
    name: "BISTRO CAVA CAVA",
    publicUrl: "https://tabelog.com/tokyo/A1309/A130903/13245351/",
    competitorCap: 5,
    areas: [
      // 2026-10-05 tabelog.com の一覧タイトルで確認（A1309 = 四ツ谷・市ヶ谷・飯田橋）。A1304/A130404 は大久保、A1304/A130401 は新宿なので使わない。
      { areaKey: "akebonobashi_yotsuya3", areaLabel: "曙橋・四ツ谷三丁目", path: "tokyo/A1309/A130903" },
      { areaKey: "yotsuya", areaLabel: "四ツ谷", path: "tokyo/A1309/A130902" },
      { areaKey: "ichigaya", areaLabel: "市ヶ谷", path: "tokyo/A1309/A130904" },
    ],
    genres: [
      { genreKey: "bistro", genreLabel: "ビストロ", slug: "bistro" },
      // ワインバーは英字スラッグが無くジャンルコード BC0103（"winebar" は無視されて全ジャンル一覧になる）
      { genreKey: "winebar", genreLabel: "ワインバー", slug: "BC0103" },
      { genreKey: "french", genreLabel: "フレンチ", slug: "french" },
    ],
  },
};

export function storePublicConfig(storeKey) {
  const key = String(storeKey ?? "");
  return STORE_PUBLIC_CONFIG[key] ?? null;
}

/** 公開ランキング／ニューオープン URL を組み立てる（確認用・フェッチ用）。sort: rating|newopen */
export function publicListUrl({ areaPath, genreSlug, sort = "rating" }) {
  const base = `https://tabelog.com/${areaPath}/rstLst/${genreSlug}/`;
  if (sort === "newopen") return `${base}?Srt=D&SrtT=nod`;
  // 評価順（標準の総合点順）
  return `${base}?Srt=D&SrtT=rt`;
}

/** ルーチン向け: この店舗で取得すべき公開一覧 URL */
export function publicFetchPlan(storeKey) {
  const cfg = storePublicConfig(storeKey);
  if (!cfg) return { storeKey: String(storeKey ?? ""), pages: [] };
  const pages = [];
  pages.push({ page: "tabelog_public_store", title: "自店公開ページ", url: cfg.publicUrl, role: "self" });
  for (const area of cfg.areas) {
    for (const genre of cfg.genres) {
      pages.push({
        page: "tabelog_public_rank_genre",
        title: `${area.areaLabel} × ${genre.genreLabel}（評価順）`,
        url: publicListUrl({ areaPath: area.path, genreSlug: genre.slug, sort: "rating" }),
        areaKey: area.areaKey, areaLabel: area.areaLabel, genreKey: genre.genreKey, genreLabel: genre.genreLabel, sort: "rating",
      });
      pages.push({
        page: "tabelog_public_rank_newopen",
        title: `${area.areaLabel} × ${genre.genreLabel}（ニューオープン順）`,
        url: publicListUrl({ areaPath: area.path, genreSlug: genre.slug, sort: "newopen" }),
        areaKey: area.areaKey, areaLabel: area.areaLabel, genreKey: genre.genreKey, genreLabel: genre.genreLabel, sort: "newopen",
      });
    }
  }
  return { storeKey: String(storeKey ?? ""), name: cfg.name, competitorCap: cfg.competitorCap, pages };
}
