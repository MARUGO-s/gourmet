// 食べログの毎朝の取得で、管理画面ページ（PAGE_CATALOG）に加えて必要な2つの手順。
// page-snapshots.mjs list --source tabelog が一覧の最後に出す（/pages/ingest には送らない）。
//   公開: 自店の公開ページ（ログイン不要）を保存 → convert-manifest の "public"（店舗総合点・口コミ総数）
//   ブラウザ: マイレポートを開いたまま readTopPages() を実行した JSON → convert-manifest の "topPages"（よく見られるページ）
import { storePublicConfig } from "./store-config.js";

export function tabelogRoutineExtras(storeKey) {
  const cfg = storePublicConfig(storeKey);
  const out = [];
  if (cfg?.publicUrl) out.push({ kind: "公開", pii: false, page: "tabelog_public_store", period: "today", url: cfg.publicUrl, title: "自店の公開ページ（ブラウザで開いて保存。ログイン不要・curlはCloudflareで403→manifest public: tabelog_public_store.html）" });
  out.push({ kind: "ブラウザ", pii: false, page: "tabelog_top_pages", period: "today", url: "https://owner.tabelog.com/owner_rst/my_report/", title: "よく見られるページ（開いたまま readTopPages() の結果を top-pages.json に保存→manifest topPages）" });
  return out;
}
