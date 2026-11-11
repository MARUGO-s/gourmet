// 食べログの毎朝の取得で、管理画面ページ（PAGE_CATALOG）に加えて必要な追加手順。
// page-snapshots.mjs list --source tabelog が一覧の最後に出す（/pages/ingest には送らない）。
//   公開: 自店の公開ページ（ログイン不要）を保存 → convert-manifest の "public"（店舗総合点・口コミ総数）
//   ブラウザ: マイレポートを開いたまま readTopPages() を実行した JSON → convert-manifest の "topPages"（よく見られるページ）
//   公開取得: scripts/tabelog/public-fetch.mjs（競合・エリア×ジャンル順位・ニューオープン。構造化 JSON を /ingest）
import { storePublicConfig } from "./store-config.js";

export function tabelogRoutineExtras(storeKey) {
  const cfg = storePublicConfig(storeKey);
  const out = [];
  if (cfg?.publicUrl) out.push({ kind: "公開", pii: false, page: "tabelog_public_store", period: "today", url: cfg.publicUrl, title: "自店の公開ページ（ブラウザで開いて保存。ログイン不要・curlの既定UAは403・Ctrl+S不可。通常は public-fetch.mjs が HTTP でも取得。手動なら DevTools で copy(document.documentElement.outerHTML)→シェルでファイルへ→manifest public: tabelog_public_store.html）" });
  out.push({ kind: "ブラウザ", pii: false, page: "tabelog_top_pages", period: "today", url: "https://owner.tabelog.com/owner_rst/my_report/", title: "よく見られるページ（開いたまま readTopPages() の結果を top-pages.json に保存→manifest topPages）" });
  if (cfg) out.push({ kind: "公開取得", pii: false, page: "tabelog_public_lists", period: "today", url: "scripts/tabelog/public-fetch.mjs", title: "公開ランキング（競合・エリア×ジャンル順位・ニューオープン）。ログイン不要。node scripts/tabelog/public-fetch.mjs --store <店舗ID> --ingest --token-file ~/.review-agent/ingest_token（間隔を空けて取得。CAPTCHA回避はしない。制限されたら止める。保存先 /workspace/run-YYYYMMDD-tabelog-public/。管理画面の日別・月別は含めない）" });
  return out;
}
