#!/usr/bin/env node
// 食べログ週報 HTML のエクスポート入口（共通 CLI scripts/weekly-report.mjs --site tabelog の薄いラッパー）。
// 見た目は全サイト共通テンプレート scripts/shared/weekly-report.js、食べログ固有の内容は scripts/tabelog/weekly-report.js。
//   node scripts/tabelog-weekly-report.mjs --input weekly-input.json --out weekly-report.html
// 詳細: docs/weekly-report.md / docs/tabelog-weekly-report.md
import { runWeeklyReportCli } from "./weekly-report.mjs";

runWeeklyReportCli(process.argv.slice(2), { site: "tabelog", entry: "scripts/tabelog-weekly-report.mjs" });
