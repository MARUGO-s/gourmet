#!/usr/bin/env node
// 週報の入力を「最新の実取得データ」から組み立てる（配信の前に必ず使う。手書きの stub 入力は使わない）。ネットワークには接続しない。
//   node scripts/weekly-assemble.mjs --runs-dir /workspace \
//     --tabelog-store 13245351 --ikyu-store 112789 --name "BISTRO CAVA CAVA" [--as-of 2026-10-05] \
//     --out-dir /workspace/run-YYYYMMDD-weekly-<店舗> [--allow-gaps]
//   追加・上書きの元ファイル（任意・複数可）: --tabelog-payload f.json --ikyu-payload f.json --owner-home owner-home.html --access-ranking tabelog_access_ranking-2026-09.html
// 出力: <out-dir>/tabelog-input.json・ikyu-input.json（assembled = 元ファイル・取得日時・足りない項目）と assemble-report.json。
// 終了コード: 0 = 送ってよい / 1 = 必須の実データが欠けている・stub を検出（送らない）/ 3 = 公開ページなど取れるはずの項目が欠けている（取り直すか --allow-gaps）。
// 次: node scripts/weekly-deliver.mjs --tabelog-input <out>/tabelog-input.json --ikyu-input <out>/ikyu-input.json … --publish-dir public（docs/weekly-report.md）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./agent-common.mjs";
import { assembleIkyuSources, assembleTabelogSources, assembledStamp, discoverRunFiles } from "./shared/weekly-sources.js";

const japanToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const list = (v) => (v === undefined || v === true ? [] : [].concat(v).map(String));

export function runWeeklyAssemble(argv, { log = console.error, now = new Date() } = {}) {
  const args = parseArgs(argv);
  const asOf = typeof args["as-of"] === "string" ? args["as-of"] : japanToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("--as-of は YYYY-MM-DD です");
  const tabelogStore = typeof args["tabelog-store"] === "string" ? args["tabelog-store"] : null;
  const ikyuStore = typeof args["ikyu-store"] === "string" ? args["ikyu-store"] : null;
  if (!tabelogStore && !ikyuStore) throw new Error("--tabelog-store か --ikyu-store を指定してください");
  if (typeof args["out-dir"] !== "string") throw new Error("--out-dir を指定してください");
  const name = typeof args.name === "string" ? args.name : undefined;
  const allowGaps = args["allow-gaps"] === true;
  const found = typeof args["runs-dir"] === "string" ? discoverRunFiles(args["runs-dir"]) : { payloads: [], ownerHomes: [], rankings: [], skipped: [] };
  const ranking = (file) => ({ file, month: path.basename(file).match(/(\d{4}-\d{2})/)?.[1] ?? "" });
  fs.mkdirSync(args["out-dir"], { recursive: true });

  const report = { asOf, outDir: path.resolve(args["out-dir"]), skippedDirs: found.skipped, sites: {} };
  const files = {};
  if (tabelogStore) {
    const r = assembleTabelogSources({
      storeKey: tabelogStore, storeName: name, asOf,
      payloadFiles: [...found.payloads, ...list(args["tabelog-payload"])],
      ownerHomeFiles: [...found.ownerHomes, ...list(args["owner-home"])],
      rankingFiles: [...found.rankings, ...list(args["access-ranking"]).map(ranking)],
    });
    const out = { ...r.input, assembled: assembledStamp({ site: "tabelog", asOf, result: r, allowGaps, now }) };
    files.tabelog = path.join(args["out-dir"], "tabelog-input.json");
    fs.writeFileSync(files.tabelog, `${JSON.stringify(out, null, 2)}\n`);
    report.sites.tabelog = { file: files.tabelog, problems: r.problems, gaps: r.gaps, knownGaps: r.knownGaps, sources: out.assembled.sources, rejected: out.assembled.rejected };
  }
  if (ikyuStore) {
    const r = assembleIkyuSources({ storeKey: ikyuStore, storeName: name, asOf, payloadFiles: [...found.payloads, ...list(args["ikyu-payload"])] });
    const out = { ...(r.input ?? { storeKey: ikyuStore, storeName: name, asOf }), assembled: assembledStamp({ site: "ikyu", asOf, result: r, allowGaps, now }) };
    files.ikyu = path.join(args["out-dir"], "ikyu-input.json");
    fs.writeFileSync(files.ikyu, `${JSON.stringify(out, null, 2)}\n`);
    report.sites.ikyu = { file: files.ikyu, problems: r.problems, gaps: r.gaps, knownGaps: r.knownGaps, sources: out.assembled.sources, rejected: out.assembled.rejected };
  }
  const sites = Object.values(report.sites);
  const problems = sites.flatMap((s) => s.problems), gaps = sites.flatMap((s) => s.gaps);
  report.ok = !problems.length && (!gaps.length || allowGaps);
  report.exitCode = problems.length ? 1 : gaps.length && !allowGaps ? 3 : 0;
  report.next = [
    "node", "scripts/weekly-deliver.mjs",
    ...(files.tabelog ? ["--tabelog-input", files.tabelog] : []),
    ...(files.ikyu ? ["--ikyu-input", files.ikyu] : []),
    ...(name ? ["--name", JSON.stringify(name)] : []),
    "--store-id", "<店舗UUID>", "--as-of", asOf, "--out-dir", path.join(args["out-dir"], "weekly"), "--publish-dir", "public",
  ].join(" ");
  fs.writeFileSync(path.join(args["out-dir"], "assemble-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  log(`週報の入力を組み立てました（${asOf}）: ${Object.keys(files).join("・")} → ${args["out-dir"]}`);
  for (const p of problems) log(`  ✗ ${p}`);
  for (const g of gaps) log(`  △ ${g}${allowGaps ? "（--allow-gaps: 「未取得」で続ける）" : ""}`);
  for (const k of sites.flatMap((s) => s.knownGaps)) log(`  ・ ${k}（未対応のため「未取得」）`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = runWeeklyAssemble(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ ok: report.ok, exitCode: report.exitCode, asOf: report.asOf, sites: Object.fromEntries(Object.entries(report.sites).map(([k, s]) => [k, { file: s.file, problems: s.problems, gaps: s.gaps, sources: s.sources.length, rejected: s.rejected.length }])), next: report.next }, null, 2)}\n`);
    process.exitCode = report.exitCode;
  } catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 1; }
}
