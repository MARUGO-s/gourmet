#!/usr/bin/env node
// 週報を M-talk の店舗Bot のルームへ届ける（Grok Bot の月曜の作業用）。週報のビュー（共通テンプレート）から
//   ① サイト別の週報 HTML ＋ ハブ HTML（GitHub Pages に載せ、「週報を開く」で開く）② 任意の PDF ③ カードの要約 を作り、
//   agent-api POST /weekly/deliver（X-Ingest-Token）へ渡す。M-talk への署名・GOURMET_MTALK_TOKEN は gourmet の Edge Function だけが持つ。
// 既定は確認だけ（dryRun: M-talk でも投稿しない）。実際に投稿するのは --send を付けたときだけ。--no-post は agent-api も呼ばない。
// PDF は任意（--pdf）。本体は HTML（Pages）。M-talk /store-post は HTML 添付不可・marugo-s.github.io リンク可。
//
//   入力は scripts/weekly-assemble.mjs の出力（assembled 付き）を使う。--send は stub・手書きの入力を拒否する。
//   INGEST_TOKEN=... node scripts/weekly-deliver.mjs \
//     --tabelog-input <assemble>/tabelog-input.json \
//     --ikyu-input <assemble>/ikyu-input.json \
//     --name "BISTRO CAVA CAVA" --store-id <gourmet の店舗 UUID> [--as-of 2026-10-05] [--room 30] \
//     [--out-dir run-xxx/weekly] [--publish-dir public] [--pdf] [--send | --no-post]
//
// 店舗: --store-id、無ければ最初のサイトの店舗キー（食べログの storeKey・一休の店舗ID）からアプリの店舗を探す。
// Pages に載せる HTML は --store-id 必須（URL が店舗 UUID）。同じ店舗×週は1回だけ届く。詳細: docs/weekly-report.md
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_ENDPOINT, callAgentApi, parseArgs, readToken } from "./agent-common.mjs";
import { SITES } from "./weekly-report.mjs";
import { renderWeeklyHubHtml, renderWeeklyReportHtml } from "./shared/weekly-report.js";
import { renderWeeklyPdf, weeklyCardSection } from "./shared/weekly-pdf.js";
import { loadReportFonts, renderReportPdf } from "../supabase/functions/_shared/report-pdf.js";
import { bytesToBase64 } from "../supabase/functions/_shared/mtalk-share.js";
import { looksLikePersonalInfo, validateWeeklyDeliverInput, weeklyFileName, weeklyHtmlRepoPath, weeklyHtmlUrl } from "../supabase/functions/_shared/weekly-delivery.js";
import { payloadProblem, sendBlockers } from "./shared/weekly-sources.js";

const japanToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const has = (v) => v !== undefined && v !== true;

/** 引数 → サイトごとのビュー（指定されたサイトだけ。順番は食べログ → 一休）。 */
export function buildViews(args) {
  const asOf = typeof args["as-of"] === "string" ? args["as-of"] : undefined;
  const views = [];
  if (has(args["tabelog-input"])) views.push(SITES.tabelog.view({ input: args["tabelog-input"] }));
  if (has(args["ikyu-input"]) || has(args["ikyu-payload"])) {
    views.push(SITES.ikyu.view({ input: args["ikyu-input"], payload: args["ikyu-payload"], store: args["ikyu-store"], name: args.name, "as-of": asOf ?? japanToday() }));
  }
  if (!views.length) throw new Error("--tabelog-input か --ikyu-payload / --ikyu-input を指定してください");
  const asOfs = [...new Set(views.map((v) => v.asOf))];
  if (asOfs.length > 1) throw new Error(`サイトごとの作成日が違います（${asOfs.join("・")}）。--as-of と入力 JSON の asOf をそろえてください`);
  return views;
}

/** ビュー → サイト別 HTML ＋ ハブ HTML（Pages / 手元確認用）。 */
export function writeWeeklyHtmlFiles(views, destDir, { storeName, asOf } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const name = storeName || views[0].storeName;
  const day = asOf || views[0].asOf;
  const written = [];
  for (const v of views) {
    const file = `${v.site.key}.html`;
    fs.writeFileSync(path.join(destDir, file), renderWeeklyReportHtml(v));
    written.push(file);
  }
  fs.writeFileSync(path.join(destDir, "index.html"), renderWeeklyHubHtml(views, { storeName: name, asOf: day }));
  written.push("index.html");
  return written;
}

/** ビュー → agent-api /weekly/deliver の本文（PDF は任意・base64）。 */
export function deliverPayload({ views, pdf, args }) {
  const storeName = typeof args.name === "string" ? args.name : views[0].storeName;
  const first = views[0];
  const body = {
    ...(typeof args["store-id"] === "string" ? { storeId: args["store-id"] } : { site: { source: first.site.key, storeKey: String(first.storeKey ?? "") } }),
    asOf: first.asOf,
    sections: views.map(weeklyCardSection),
    ...(pdf ? { pdf: { base64: bytesToBase64(pdf), filename: weeklyFileName(storeName, first.asOf) } } : {}),
    ...(args.room !== undefined ? { roomIds: [].concat(args.room).map(Number) } : {}),
    dryRun: args.send !== true,
  };
  validateWeeklyDeliverInput(body); // agent-api と同じ検証（個人情報・HTML の添付などを送る前に止める）
  return body;
}

export async function runWeeklyDeliver(argv, { fetcher = fetch, log = console.error, env = process.env } = {}) {
  const args = parseArgs(argv);
  const views = buildViews(args);
  const storeName = typeof args.name === "string" ? args.name : views[0].storeName;
  const asOf = views[0].asOf;
  const wantPdf = args.pdf === true;
  let pdf = null;
  if (wantPdf || typeof args["out-dir"] === "string") {
    // out-dir があるときは手元確認用に PDF も書く（M-talk へは --pdf のときだけ載せる）
    const [PDFLib, fontkit, fontModule] = await Promise.all([import("pdf-lib"), import("fontkit"), import("../supabase/functions/_shared/fonts/noto-sans-jp.js")]);
    pdf = await renderWeeklyPdf({ PDFLib, fontkit: fontkit.default ?? fontkit, fonts: await loadReportFonts(fontModule), renderReportPdf, views, storeName, asOf });
  }
  const body = deliverPayload({ views, pdf: wantPdf ? pdf : null, args });
  if (body.sections.some((s) => [...s.fields.flatMap((f) => [f.label, f.value]), ...s.items].some(looksLikePersonalInfo))) throw new Error("カードに個人情報らしき文字列があります");

  // Pages への公開（--publish-dir）と送信（--send）は、assemble を通した実データの入力だけ（手書き・stub の入力は公開も送信もしない）。
  // --allow-unassembled はテスト・手元確認用（月曜の配信では使わない）。
  if ((args.send === true || typeof args["publish-dir"] === "string") && args["allow-unassembled"] !== true) {
    const check = [];
    if (typeof args["tabelog-input"] === "string") check.push(...sendBlockers(JSON.parse(fs.readFileSync(args["tabelog-input"], "utf8")), { asOf }).map((m) => `食べログ: ${m}`));
    if (typeof args["ikyu-input"] === "string") check.push(...sendBlockers(JSON.parse(fs.readFileSync(args["ikyu-input"], "utf8")), { asOf }).map((m) => `一休: ${m}`));
    // --ikyu-payload だけのときも、組み立ての元が stub なら止める（日別の合成値）
    for (const f of [].concat(args["ikyu-payload"] ?? []).filter((x) => typeof x === "string")) {
      const problem = payloadProblem(JSON.parse(fs.readFileSync(f, "utf8")));
      if (problem) check.push(`一休の取り込み JSON（${f}）: ${problem}`);
    }
    if (check.length) throw new Error(`実データの週報入力ではありません。scripts/weekly-assemble.mjs で組み立て直してください。\n${check.join("\n")}`);
  }

  const htmlDirs = [];
  if (typeof args["out-dir"] === "string") {
    fs.mkdirSync(args["out-dir"], { recursive: true });
    // 互換: サイト別ファイルもルートに残す（手元確認）
    for (const v of views) fs.writeFileSync(path.join(args["out-dir"], `${v.site.key}-weekly-${asOf}.html`), renderWeeklyReportHtml(v));
    const localHtmlDir = path.join(args["out-dir"], "html");
    writeWeeklyHtmlFiles(views, localHtmlDir, { storeName, asOf });
    htmlDirs.push(localHtmlDir);
    if (pdf) fs.writeFileSync(path.join(args["out-dir"], weeklyFileName(storeName, asOf)), pdf);
    const { pdf: _omit, ...card } = body;
    fs.writeFileSync(path.join(args["out-dir"], `weekly-card-${asOf}.json`), `${JSON.stringify(card, null, 2)}\n`);
    log(`週報を書きました: ${args["out-dir"]}（HTML ${views.length}サイト＋ハブ・${pdf ? `PDF ${pdf.length} bytes・` : ""}カード）`);
  }

  if (typeof args["publish-dir"] === "string") {
    if (typeof args["store-id"] !== "string") throw new Error("Pages に載せるには --store-id（店舗 UUID）が必要です");
    const rel = weeklyHtmlRepoPath(args["store-id"], asOf);
    const dest = path.join(args["publish-dir"], rel);
    writeWeeklyHtmlFiles(views, dest, { storeName, asOf });
    htmlDirs.push(dest);
    log(`Pages 用 HTML: ${dest}/ → ${weeklyHtmlUrl(args["store-id"], asOf)}`);
  }

  if (args["no-post"] === true) {
    return {
      posted: false,
      dryRun: true,
      body: {
        ...body,
        pdf: body.pdf ? { filename: body.pdf.filename, bytes: pdf?.length ?? null } : null,
        html: typeof args["store-id"] === "string" ? { url: weeklyHtmlUrl(args["store-id"], asOf), dirs: htmlDirs } : { dirs: htmlDirs },
      },
    };
  }
  const token = readToken(args, env);
  const endpoint = typeof args.endpoint === "string" ? args.endpoint : DEFAULT_ENDPOINT;
  const { status, body: res } = await callAgentApi("/weekly/deliver", body, { endpoint, token, fetcher });
  if (status !== 200) throw new Error(`週報を届けられませんでした（${status}）: ${res?.error ?? "不明なエラー"}`);
  return { posted: res?.ok === true && !body.dryRun, dryRun: body.dryRun, result: res };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWeeklyDeliver(process.argv.slice(2)).then((out) => {
    const r = out.result;
    if (r && r.ok === false) console.error(`送りませんでした: ${r.skipped}`);
    else if (r) console.error(`${out.dryRun ? "【確認だけ（dryRun）】" : ""}${r.store?.name} → ${r.bot?.name}（${(r.rooms ?? []).map((x) => x.name).join("、") || "ルームなし"}）${r.deduplicated ? "（送信済みのため再投稿なし）" : ""}${r.html?.url ? ` / ${r.html.url}` : ""}`);
    process.stdout.write(`${JSON.stringify(out.result ?? out.body, null, 2)}\n`);
  }).catch((error) => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
}
