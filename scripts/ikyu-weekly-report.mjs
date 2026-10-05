#!/usr/bin/env node
// 一休週報 HTML のエクスポート入口（共通 CLI scripts/weekly-report.mjs --site ikyu の薄いラッパー）。
// 見た目は全サイト共通テンプレート scripts/shared/weekly-report.js、一休固有の内容は scripts/ikyu/weekly-report.js。
//   node scripts/ikyu-weekly-report.mjs --payload payload.json [--payload older.json] --store 112789 \
//     --name "BISTRO CAVA CAVA" [--as-of 2026-10-05] --out ikyu-weekly.html
//   node scripts/ikyu-weekly-report.mjs --input ikyu-weekly-input.json --out ikyu-weekly.html
// 詳細: docs/weekly-report.md
import { runWeeklyReportCli } from "./weekly-report.mjs";

runWeeklyReportCli(process.argv.slice(2), { site: "ikyu", entry: "scripts/ikyu-weekly-report.mjs" });
