#!/usr/bin/env node
// 一休の取り込み形式のJSONファイルを agent-api（POST /ikyu/ingest）へ送る。他サイトは scripts/agent-ingest.mjs。
//   INGEST_TOKEN=... node scripts/ikyu-ingest.mjs payload.json [--endpoint URL] [--token-file PATH] [--dry-run]
// --dry-run: 送信せず、サーバーと同じ検証だけを行う。同じ runId・同じ日/月/予約番号の再送は上書き（冪等）。
import fs from "node:fs";
import { normalizeIkyuIngest } from "../supabase/functions/_shared/ikyu-data.js";
import { parseArgs, readToken, callAgentApi, DEFAULT_ENDPOINT } from "./agent-common.mjs";

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) { console.error("使い方: node scripts/ikyu-ingest.mjs payload.json [--dry-run]"); process.exit(2); }
try {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const checked = normalizeIkyuIngest(payload);
  console.log(`検証OK: ${checked.stores.length}店舗 / 日別PV ${checked.stores.reduce((a, s) => a + s.days.length, 0)}日 / 口コミ ${checked.stores.reduce((a, s) => a + s.reviews.length, 0)}件`);
  if (args["dry-run"]) process.exit(0);
  const { status, body } = await callAgentApi("/ikyu/ingest", payload, { endpoint: args.endpoint || process.env.AGENT_API_URL || DEFAULT_ENDPOINT, token: readToken(args) });
  if (status !== 200) { console.error(`取り込みに失敗しました（HTTP ${status}）: ${body.error ?? ""}`); process.exit(1); }
  console.log(`取り込み完了: run ${body.run_id} / ${body.stores}店舗 / 日別 ${body.days}日 / 月 ${body.months}か月 / 口コミ ${body.reviews}件（新規 ${body.new_reviews}件）${body.skippedDays ? ` / 当日以降 ${body.skippedDays}日は除外` : ""}`);
} catch (error) {
  console.error(`取り込みできませんでした: ${error.message}`);
  process.exit(1);
}
