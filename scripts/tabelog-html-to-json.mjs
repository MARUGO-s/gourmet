#!/usr/bin/env node
// 保存した食べログ店舗管理画面のHTMLを取り込み形式（agent-api /ingest、schemaVersion 1）のJSONへ変換する。
// ネットワークには接続せず、JavaScript無効のブラウザ（Playwright Chromium）でHTMLを読むだけ。ログインしない。
//   node scripts/tabelog-html-to-json.mjs --manifest manifest.json --out payload.json [--request-id UUID]
//   manifest 例: {"storeKey":"13245351","name":"店名","daily":["daily-202609.html","daily-202608.html"],
//     "conversion":"conversion.html","myReport":"my_report.html","accessRanking":"access_ranking.html",
//     "reviews":{"reply":["reply-1.html"],"pickup":["pickup-1.html"]},"public":"public.html",
//     "pageHistory":{"first":"201912","last":"202608","pc":"page-pc.html","sp":"page-sp.html","app":"page-app.html"}}
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { parseArgs } from "./agent-common.mjs";
import { readSavedTabelog } from "./tabelog/saved-html.js";
import { tabelogResultToPayload } from "./tabelog/payload.js";
import { normalizeSourceIngest } from "../supabase/functions/_shared/source-ingest.js";
import { japanDate } from "../supabase/functions/_shared/sync-data.js";

const args = parseArgs(process.argv.slice(2));
if (typeof args.manifest !== "string") { console.error("--manifest manifest.json を指定してください"); process.exit(2); }
const browser = await chromium.launch({ headless: true });
try {
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const today = japanDate();
  const { result, publicUrl } = await readSavedTabelog(manifest, path.dirname(path.resolve(args.manifest)), { browser, today });
  const payload = tabelogResultToPayload(result, { storeKey: manifest.storeKey, name: manifest.name ?? null, publicUrl: publicUrl ?? manifest.publicUrl ?? null, runId: args["run-id"], requestId: args["request-id"], today });
  const checked = normalizeSourceIngest(payload, today); // 送信前にサーバーと同じ検証
  const json = JSON.stringify(payload, null, 2);
  if (args.out) fs.writeFileSync(args.out, json); else process.stdout.write(`${json}\n`);
  const s = checked.stores[0];
  console.error(`食べログ 店舗${s.store_key || "（既定）"}: 日別 ${s.days.length}日 / 月別 ${s.months.length}か月 / 口コミ ${s.reviews.length}件 / レポート ${s.reports.length}件 / 状態 ${checked.run.status}`);
  if (payload.warning) console.error(`注意: ${payload.warning}`);
} catch (error) {
  console.error(`変換できませんでした: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
