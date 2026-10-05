#!/usr/bin/env node
// 週報 HTML の共通エクスポート入口（全サイト共通テンプレート = scripts/shared/weekly-report.js）。ネットワークには接続しない。
//   食べログ: node scripts/weekly-report.mjs --site tabelog --input weekly-input.json --out weekly-report.html
//   一休:     node scripts/weekly-report.mjs --site ikyu --input ikyu-weekly-input.json --out ikyu-weekly.html
//             node scripts/weekly-report.mjs --site ikyu --payload payload.json [--payload older.json] \
//               --store 112789 --name "BISTRO CAVA CAVA" [--as-of 2026-10-05] --out ikyu-weekly.html
//   （--payload は scripts/ikyu-html-to-json.mjs の出力 JSON。複数指定すると capturedAt の古い順に重ねる）
// 詳細: docs/weekly-report.md
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./agent-common.mjs";
import { renderWeeklyReportHtml } from "./shared/weekly-report.js";
import { assembleWeeklyReportInput, buildTabelogWeeklyView } from "./tabelog/weekly-report.js";
import { assembleIkyuWeeklyInput, buildIkyuWeeklyView } from "./ikyu/weekly-report.js";

const japanToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const list = (v) => (v === undefined || v === true ? [] : [].concat(v));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export const SITES = {
  tabelog: {
    label: "食べログ",
    usage: "--site tabelog --input weekly-input.json [--out weekly-report.html]",
    /** 共通テンプレートのビュー（HTML と PDF・M-talk のカードの元。scripts/weekly-deliver.mjs も使う） */
    view(args) {
      if (typeof args.input !== "string") throw new Error("--input（assembleWeeklyReportInput に渡す JSON）を指定してください");
      const raw = readJson(args.input);
      if (!raw?.storeKey || !raw?.storeName || !raw?.asOf) throw new Error("storeKey / storeName / asOf が必要です");
      // monthlyRows/dailyRows 付き、または monthly 未整形なら assemble。それ以外は build 用入力としてそのまま使う。
      const needsAssemble = Array.isArray(raw.monthlyRows) || Array.isArray(raw.dailyRows) || raw.monthly == null;
      return buildTabelogWeeklyView(needsAssemble ? assembleWeeklyReportInput(raw) : raw);
    },
    build(args) { return renderWeeklyReportHtml(this.view(args)); },
  },
  ikyu: {
    label: "一休",
    usage: "--site ikyu (--input ikyu-weekly-input.json | --payload payload.json [--payload …] --store 112789) [--name 店舗名] [--as-of YYYY-MM-DD] [--out ikyu-weekly.html]",
    view(args) {
      const raw = typeof args.input === "string" ? readJson(args.input) : {};
      const payloads = [...(raw.payloads ?? []), ...list(args.payload).map(readJson)];
      const storeKey = String(args.store ?? raw.storeKey ?? "");
      if (!/^\d{6}$/.test(storeKey)) throw new Error("一休の店舗ID（6桁）を --store または入力 JSON の storeKey で指定してください");
      if (!payloads.length && !raw.monthlyRows && !raw.dailyRows && raw.monthly == null) {
        throw new Error("--payload（取り込み JSON）または --input（monthlyRows / dailyRows など）を指定してください");
      }
      const asOf = typeof args["as-of"] === "string" ? args["as-of"] : raw.asOf ?? japanToday();
      const storeName = typeof args.name === "string" ? args.name : raw.storeName;
      // monthly 整形済み（assemble の出力）ならそのまま描画
      const input = raw.monthly != null && !payloads.length
        ? { ...raw, storeKey, asOf, storeName: storeName ?? raw.storeName }
        : assembleIkyuWeeklyInput({ ...raw, payloads, storeKey, storeName, asOf });
      return buildIkyuWeeklyView(input);
    },
    build(args) { return renderWeeklyReportHtml(this.view(args)); },
  },
};

export function runWeeklyReportCli(argv, { site: fixedSite, entry = "scripts/weekly-report.mjs" } = {}) {
  const args = parseArgs(argv);
  const siteKey = fixedSite ?? args.site;
  const site = SITES[siteKey];
  if (!site) {
    console.error(`使い方: node ${entry} --site <${Object.keys(SITES).join("|")}> …`);
    for (const [k, s] of Object.entries(SITES)) console.error(`  ${s.label}（${k}）: node ${entry} ${s.usage}`);
    process.exitCode = 2;
    return;
  }
  try {
    const html = site.build(args);
    if (typeof args.out === "string") {
      fs.writeFileSync(args.out, html);
      console.error(`${site.label}週報 HTML（共通テンプレート）を書きました: ${args.out}（${html.length} bytes）`);
    } else {
      process.stdout.write(html);
    }
  } catch (error) {
    console.error(`週報 HTML を生成できませんでした: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runWeeklyReportCli(process.argv.slice(2));
