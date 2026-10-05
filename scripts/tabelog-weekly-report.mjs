#!/usr/bin/env node
// 食べログ週報 HTML の既定エクスポート入口。
// UI・内容ルールは docs/tabelog-weekly-report.md。生成は scripts/tabelog/weekly-report.js のみ。
//   node scripts/tabelog-weekly-report.mjs --input weekly-input.json --out weekly-report.html
import fs from "node:fs";
import { parseArgs } from "./agent-common.mjs";
import { assembleWeeklyReportInput, buildWeeklyReportHtml } from "./tabelog/weekly-report.js";

const args = parseArgs(process.argv.slice(2));
if (typeof args.input !== "string") {
  console.error("使い方: node scripts/tabelog-weekly-report.mjs --input weekly-input.json [--out weekly-report.html]");
  console.error("入力は assembleWeeklyReportInput に渡す JSON（storeKey / storeName / asOf 必須）");
  process.exit(2);
}

try {
  const raw = JSON.parse(fs.readFileSync(args.input, "utf8"));
  if (!raw?.storeKey || !raw?.storeName || !raw?.asOf) {
    throw new Error("storeKey / storeName / asOf が必要です");
  }
  // monthlyRows/dailyRows 付き、または monthly 未整形なら assemble。それ以外は build 用入力としてそのまま使う。
  const needsAssemble = Array.isArray(raw.monthlyRows) || Array.isArray(raw.dailyRows) || raw.monthly == null;
  const assembled = needsAssemble ? assembleWeeklyReportInput(raw) : raw;
  const html = buildWeeklyReportHtml(assembled);
  if (typeof args.out === "string") {
    fs.writeFileSync(args.out, html);
    console.error(`食べログ週報 HTML（既定テンプレート）を書きました: ${args.out}（${html.length} bytes）`);
  } else {
    process.stdout.write(html);
  }
} catch (error) {
  console.error(`週報 HTML を生成できませんでした: ${error.message}`);
  process.exitCode = 1;
}
