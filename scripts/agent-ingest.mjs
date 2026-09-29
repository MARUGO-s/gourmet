#!/usr/bin/env node
// 取り込み形式のJSONファイル（どのサイトでも可）を agent-api（POST /ingest）へ送る。
//   INGEST_TOKEN=... node scripts/agent-ingest.mjs payload.json [--endpoint URL] [--token-file PATH] [--dry-run]
// source="ikyu" は一休形式、それ以外は共通形式として送信前にサーバーと同じ検証を行う。再送は冪等。
import fs from "node:fs";
import { normalizeIkyuIngest } from "../supabase/functions/_shared/ikyu-data.js";
import { normalizeSourceIngest } from "../supabase/functions/_shared/source-ingest.js";
import { parseArgs, readToken, callAgentApi, DEFAULT_ENDPOINT } from "./agent-common.mjs";

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) { console.error("使い方: node scripts/agent-ingest.mjs payload.json [--dry-run]"); process.exit(2); }
try {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const ikyu = payload?.source === "ikyu"; // 一休は ikyu-html-to-json.mjs が source:"ikyu" を付ける
  const checked = ikyu ? normalizeIkyuIngest(payload) : normalizeSourceIngest(payload);
  const sum = (key) => checked.stores.reduce((a, s) => a + (s[key]?.length ?? 0), 0);
  console.log(`検証OK: ${payload.source} / ${checked.stores.length}店舗 / 日別 ${sum("days")}日 / 月別 ${sum("months")}か月 / 口コミ ${sum("reviews")}件${ikyu ? "" : ` / レポート ${sum("reports")}件`} / 状態 ${checked.run.status}`);
  if (args["dry-run"]) process.exit(0);
  const { status, body } = await callAgentApi("/ingest", payload, { endpoint: args.endpoint || process.env.AGENT_API_URL || DEFAULT_ENDPOINT, token: readToken(args) });
  if (status !== 200) { console.error(`取り込みに失敗しました（HTTP ${status}）: ${body.error ?? ""}`); process.exit(1); }
  console.log(`取り込み完了: run ${body.run_id} / ${body.stores}店舗 / 日別 ${body.days}日 / 月別 ${body.months}か月 / 口コミ ${body.reviews}件（新規 ${body.new_reviews}件）${body.skippedDays ? ` / 当日以降 ${body.skippedDays}日は除外` : ""}`);
} catch (error) {
  console.error(`取り込みできませんでした: ${error.message}`);
  process.exit(1);
}
