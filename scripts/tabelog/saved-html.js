// 保存した食べログ店舗管理画面のHTMLを、ネットワーク無し・JavaScript無効のブラウザで読み取り、
// collectTabelogMetrics と同じ結果（→ payload.js で取り込み形式）にする。ログイン・通信は一切行わない。
import fs from "node:fs";
import path from "node:path";
import { decodeHtml } from "../ikyu/html-lite.js";
import { readOwnerDailyTable, readOwnerReviews, mergeOwnerReviews, readOwnerPageTotals, readOwnerPublicUrl } from "./owner.js";
import { readConversionTable, readRanking, buildRanking, readTopPages } from "./reports.js";
import { readTabelogPublicDocument } from "./public.js";
import { collectTabelogMetrics } from "./result.js";

const OWNER = "https://owner.tabelog.com";
const withBase = (html, base) => {
  const tag = `<base href="${base}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${html}`;
};

export async function openSavedReader(browser) {
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  // fn は document を読む自己完結関数（page.evaluate で実行）
  const read = async (file, base, fn) => {
    const { html } = decodeHtml(fs.readFileSync(file));
    await page.setContent(withBase(html, base), { waitUntil: "domcontentloaded", timeout: 30000 });
    return page.evaluate(fn);
  };
  return { read, close: () => context.close() };
}

// manifest（パスは manifest のあるディレクトリ基準）:
// { storeKey, name?, daily: [..], conversion?, myReport?, accessRanking?, reviews?: {reply:[..], pickup:[..]},
//   pageHistory?: {first:"YYYYMM", last:"YYYYMM", pc, sp, app}, public?, topPages?: "top-pages.json" }
export async function readSavedTabelog(manifest, baseDir, { browser, today, onProgress } = {}) {
  const file = (f) => path.resolve(baseDir, f);
  const reader = await openSavedReader(browser);
  try {
    const list = async (files, base, fn) => { const out = []; for (const f of files ?? []) out.push(await reader.read(file(f), base, fn)); return out; };
    const reviewList = async (files, pathName) => {
      const parts = await list(files, `${OWNER}${pathName}`, readOwnerReviews);
      if (!parts.length) return { items: [], total: 0 };
      const total = parts[0].total;
      if (total == null || parts.some((p) => p.total !== total)) throw new Error("管理画面の口コミ件数を確認できません（ページ間で件数が異なります）");
      return { items: parts.flatMap((p) => p.items), total };
    };
    const collectors = {
      dailyMetrics: async () => {
        if (!manifest.daily?.length) throw new Error("日別PVのHTMLがありません");
        const all = new Map();
        for (const rows of await list(manifest.daily, `${OWNER}/owner_rst/access_report_total`, readOwnerDailyTable)) for (const r of rows) {
          const prev = all.get(r.date);
          if (prev && JSON.stringify(prev) !== JSON.stringify(r)) throw new Error(`日別PVの値がページ間で一致しません（${r.date}）`);
          all.set(r.date, r);
        }
        return { daily: [...all.values()].filter((r) => r.date < today).sort((a, b) => a.date.localeCompare(b.date)) };
      },
      monthlyMetrics: async () => {
        if (!manifest.conversion) throw new Error("来店指標のHTMLがありません");
        const result = await reader.read(file(manifest.conversion), `${OWNER}/owner_rst/access_report_total_conversion`, readConversionTable);
        if (!result.months?.length || new Set(result.months.map((m) => m.month)).size !== result.months.length) throw new Error("月別レポートを読み取れません");
        return result;
      },
      detailReports: async (name) => {
        const summary = manifest.myReport ? await reader.read(file(manifest.myReport), `${OWNER}/owner_rst/my_report/`, readRanking) : null;
        const full = manifest.accessRanking ? await reader.read(file(manifest.accessRanking), `${OWNER}/owner_rst/access_ranking`, readRanking) : null;
        // よく見られるページはグラフ（JavaScript）の値のため、保存HTMLからは読めない。ブラウザで readTopPages した JSON を渡す。
        const topPages = manifest.topPages ? JSON.parse(fs.readFileSync(file(manifest.topPages), "utf8")) : null;
        return { topPages, ranking: buildRanking(summary, full, name) };
      },
    };
    if (manifest.reviews) collectors.ownerReviews = async () => mergeOwnerReviews(await reviewList(manifest.reviews.reply, "/owner_rst/reply_top"), await reviewList(manifest.reviews.pickup, "/owner_rst/rstupreview_entry"));
    if (manifest.public) collectors.publicMetrics = async () => reader.read(file(manifest.public), "https://tabelog.com/", readTabelogPublicDocument);
    else collectors.publicMetrics = async () => ({ rating: null, reviews: null, reviewItems: [], issue: "公開ページのHTMLが無いため、店舗総合点と口コミ総数は未取得です" });
    if (manifest.pageHistory) collectors.pageHistory = async () => {
      const devices = {};
      for (const key of ["pc", "sp", "app"]) {
        if (!manifest.pageHistory[key]) throw new Error("端末別ページレポートがありません");
        devices[key] = await reader.read(file(manifest.pageHistory[key]), `${OWNER}/owner_rst/access_report_page`, readOwnerPageTotals);
      }
      if (!/^\d{6}$/.test(String(manifest.pageHistory.first)) || !/^\d{6}$/.test(String(manifest.pageHistory.last))) throw new Error("pageHistory の first / last（YYYYMM）を指定してください");
      return { first: String(manifest.pageHistory.first), last: String(manifest.pageHistory.last), devices };
    };
    const publicUrl = manifest.daily?.[0] ? await reader.read(file(manifest.daily[0]), `${OWNER}/owner_rst/access_report_total`, readOwnerPublicUrl).catch(() => null) : null;
    const result = await collectTabelogMetrics(collectors, onProgress);
    return { result, publicUrl };
  } finally {
    await reader.close();
  }
}
