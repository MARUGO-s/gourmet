#!/usr/bin/env node
// 食べログの公開ページ（自店・エリア×ジャンルの評価順／ニューオープン順）を取得し、
// 公開レポートだけの取り込み JSON を作る。管理画面の日別・月別は含めない。
// ログイン不要。通常のブラウザ UA で HTTP 取得（2026-10-20 の公開取得と同じ）。
// CAPTCHA 回避サービスは使わない。制限されたら止める。保存先は /workspace/run-YYYYMMDD-tabelog-public/。
//
//   node scripts/tabelog/public-fetch.mjs --store 13245351
//     [--out-dir /workspace/run-YYYYMMDD-tabelog-public]
//     [--delay-ms 2500] [--from-dir DIR]
//     [--dry-run] [--ingest] [--token-file ~/.review-agent/ingest_token]
//
// --from-dir は保存済み HTML（html/0.html …、10/20 と同じ並び）だけを読む（ネットワークなし）。
// 既定は取得＋payload 作成＋ agent-ingest --dry-run（送信しない）。
// --ingest のときは dry-run のあと本番取り込みする。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { parseArgs } from "../agent-common.mjs";
import { publicFetchPlan, storePublicConfig } from "./store-config.js";
import { readTabelogPublicDocument } from "./public.js";
import { readPublicGenreRanking, readPublicNewOpenList } from "./public-lists.js";
import { normalizeSourceIngest } from "../../supabase/functions/_shared/source-ingest.js";
import {
  DEFAULT_DELAY_MS,
  PUBLIC_FETCH_UA,
  buildPublicOnlyPayload,
  isBlockedPublicPage,
  isIgnoredGenreList,
  pageTitle,
} from "./public-payload.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const japanDay = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
const yyyymmdd = (day) => day.replaceAll("-", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assertTabelogUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`公開URLが不正です: ${url}`); }
  if (u.protocol !== "https:" || u.hostname !== "tabelog.com") throw new Error(`tabelog.com 以外のURLは取得しません: ${url}`);
  return u.href;
}

export function defaultOutDir(day = japanDay()) {
  return `/workspace/run-${yyyymmdd(day)}-tabelog-public`;
}

async function fetchPage(url, { delayMs, lastAt }) {
  if (lastAt && delayMs > 0) {
    const wait = delayMs - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
  }
  const href = assertTabelogUrl(url);
  const res = await fetch(href, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": PUBLIC_FETCH_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const html = buf.toString("utf8");
  const title = pageTitle(html);
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`リダイレクトを辿りません（HTTP ${res.status} → ${loc ?? "?"}）: ${href}`);
  }
  const blocked = isBlockedPublicPage({ status: res.status, html, title });
  if (blocked) throw new Error(`公開ページが制限されました（${blocked}）。回避せず停止しました: ${href}`);
  if (res.status !== 200) throw new Error(`公開ページが HTTP ${res.status} を返しました: ${href}`);
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype && !/html|xml|text\/plain/i.test(ctype)) throw new Error(`HTML ではありません（${ctype}）: ${href}`);
  if (isIgnoredGenreList(title)) throw new Error(`ジャンル指定が無視されています（タイトル: ${title}）: ${href}`);
  return { status: res.status, bytes: buf.length, html, title, fetchedAt: new Date().toISOString() };
}

function htmlPath(dir, i) {
  return path.join(dir, "html", `${i}.html`);
}

async function parseSavedPagesWithArgs({ plan, storeKey, htmlDir, browser }) {
  const { decodeHtml } = await import("../ikyu/html-lite.js");
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  const withBase = (html, base) => {
    const tag = `<base href="${base}">`;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${html}`;
  };
  const pages = [];
  try {
    for (const [i, p] of plan.pages.entries()) {
      const file = htmlPath(htmlDir, i);
      if (!fs.existsSync(file)) throw new Error(`保存 HTML がありません: ${file}`);
      const { html } = decodeHtml(fs.readFileSync(file));
      const title = pageTitle(html);
      const blocked = isBlockedPublicPage({ status: 200, html, title });
      if (blocked) throw new Error(`保存 HTML に制限画面が含まれています（${blocked}）: ${file}`);
      if (isIgnoredGenreList(title)) throw new Error(`ジャンル指定が無視されています（タイトル: ${title}）: ${p.url}`);
      await page.setContent(withBase(html, p.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      let parsed;
      if (p.page === "tabelog_public_store") {
        parsed = await page.evaluate(readTabelogPublicDocument);
        if (parsed?.diagnostics?.challenged) {
          throw new Error(`公開店舗ページに追加認証またはアクセス制限が表示されています。回避せず停止しました: ${p.url}`);
        }
        if (parsed.rating == null || parsed.reviews == null) {
          throw new Error(`自店公開ページの評価・口コミ数を読めませんでした: ${p.url}`);
        }
      } else if (p.sort === "rating") {
        parsed = await page.evaluate(readPublicGenreRanking, { selfStoreId: String(storeKey), limit: 20 });
        if (parsed?.challenged) throw new Error(`公開一覧に追加認証またはアクセス制限が表示されています。回避せず停止しました: ${p.url}`);
        if (!parsed.entries?.length) throw new Error(`評価順一覧の掲載が0件です（読み取り失敗の可能性）: ${p.url}`);
      } else {
        parsed = await page.evaluate(readPublicNewOpenList, { limit: 30 });
        if (parsed?.challenged) throw new Error(`公開一覧に追加認証またはアクセス制限が表示されています。回避せず停止しました: ${p.url}`);
        if (!parsed.entries?.length) throw new Error(`ニューオープン順一覧の掲載が0件です（読み取り失敗の可能性）: ${p.url}`);
      }
      pages.push({ i, ...p, title, parsed });
    }
  } finally {
    await context.close();
  }
  return pages;
}

function toRankingsAndOpens(pages) {
  const rankings = pages.filter((p) => p.sort === "rating").map((p) => ({
    areaKey: p.areaKey, genreKey: p.genreKey, area: p.areaLabel, genre: p.genreLabel, url: p.url,
    selfRank: p.parsed.selfRank ?? null, totalOrganic: p.parsed.totalOrganic ?? null, entries: p.parsed.entries ?? [],
  }));
  const opens = pages.filter((p) => p.sort === "newopen").map((p) => ({
    areaKey: p.areaKey, genreKey: p.genreKey, area: p.areaLabel, genre: p.genreLabel, url: p.url,
    entries: p.parsed.entries ?? [],
  }));
  const selfPage = pages.find((p) => p.page === "tabelog_public_store");
  const self = selfPage?.parsed ?? null;
  return { self, rankings, opens };
}

function slimResults(pages) {
  return pages.map((p) => {
    const parsed = p.parsed ?? {};
    if (p.page === "tabelog_public_store") {
      const { reviewItems, ...rest } = parsed;
      return { i: p.i, page: p.page, url: p.url, title: p.title, parsed: { ...rest, reviewItems: Array.isArray(reviewItems) ? reviewItems.length : 0 } };
    }
    return { i: p.i, page: p.page, sort: p.sort, areaKey: p.areaKey, genreKey: p.genreKey, url: p.url, title: p.title, parsed };
  });
}

function ingestCli({ payloadFile, tokenFile, dryRun }) {
  const script = path.join(REPO, "scripts/agent-ingest.mjs");
  const args = [script, payloadFile];
  if (dryRun) args.push("--dry-run");
  else if (tokenFile) args.push("--token-file", tokenFile);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(dryRun ? "取り込みの検証（dry-run）に失敗しました" : "取り込みに失敗しました");
  return r.stdout ?? "";
}

export async function runPublicFetch(argv, { log = console.error, now = new Date() } = {}) {
  const args = parseArgs(argv);
  const storeKey = typeof args.store === "string" ? args.store : null;
  if (!storeKey) throw new Error("--store に食べログの店舗IDを指定してください");
  const cfg = storePublicConfig(storeKey);
  const plan = publicFetchPlan(storeKey);
  if (!cfg || !plan.pages.length) throw new Error(`店舗 ${storeKey} の公開取得プランがありません（store-config.js）`);
  const today = japanDay(now);
  const outDir = path.resolve(typeof args["out-dir"] === "string" ? args["out-dir"] : defaultOutDir(today));
  const fromDir = typeof args["from-dir"] === "string" ? path.resolve(args["from-dir"]) : null;
  const delayMs = Number.isFinite(Number(args["delay-ms"])) ? Math.max(0, Number(args["delay-ms"])) : DEFAULT_DELAY_MS;
  const doIngest = args.ingest === true;
  const dryOnly = args["dry-run"] === true;
  const tokenFile = typeof args["token-file"] === "string"
    ? args["token-file"]
    : (doIngest ? `${process.env.HOME ?? ""}/.review-agent/ingest_token` : null);

  fs.mkdirSync(path.join(outDir, "html"), { recursive: true });
  const htmlDir = fromDir ?? outDir;
  const logLines = [];
  if (!fromDir) {
    log(`公開ページを取得します（${plan.pages.length}ページ、間隔 ${delayMs}ms）: ${cfg.name} ${storeKey}`);
    let lastAt = 0;
    for (const [i, p] of plan.pages.entries()) {
      const got = await fetchPage(p.url, { delayMs, lastAt });
      lastAt = Date.now();
      fs.writeFileSync(htmlPath(outDir, i), got.html);
      const line = `${i} ${got.status} ${got.bytes} ${got.title || p.title}  ${p.url}`;
      logLines.push(line);
      log(line);
    }
    fs.writeFileSync(path.join(outDir, "fetch-log.txt"), `${logLines.join("\n")}\n`);
  } else {
    log(`保存 HTML を読みます: ${fromDir}`);
  }

  const browser = await chromium.launch({ headless: true });
  let pages;
  try {
    pages = await parseSavedPagesWithArgs({ plan, storeKey, htmlDir, browser });
  } finally {
    await browser.close();
  }

  const capturedAt = now.toISOString();
  const { self, rankings, opens } = toRankingsAndOpens(pages);
  const runId = `tabelog-${storeKey}-public-${yyyymmdd(today)}`;
  const { result, payload } = buildPublicOnlyPayload({
    self, rankings, opens, storeKey, competitorCap: cfg.competitorCap,
    name: cfg.name, publicUrl: cfg.publicUrl, runId, agent: "grok-bot", capturedAt, today,
  });
  const checked = normalizeSourceIngest(payload, today);
  const payloadFile = path.join(outDir, "payload.json");
  fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(slimResults(pages), null, 2)}\n`);
  fs.writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`);

  const kinds = checked.stores[0].reports.reduce((a, r) => { a[r.kind] = (a[r.kind] ?? 0) + 1; return a; }, {});
  const comps = result.reports.publicCompetitors?.entries ?? [];
  const home = rankings[0];
  log(`公開 payload を書きました: ${payloadFile}`);
  log(`レポート ${JSON.stringify(kinds)} / 競合 ${comps.map((c) => `${c.name}${c.own ? "(自店)" : ""}`).join(" / ")}`);
  if (home) log(`主エリア ${home.area}×${home.genre} 自店順位 ${home.selfRank ?? "掲載なし"} / 有機掲載 ${home.totalOrganic ?? "-"}件`);
  for (const r of rankings) log(`  順位 ${r.area}×${r.genre}: 自店 ${r.selfRank ?? "掲載なし"}（${r.entries.length}件）`);
  for (const r of opens) log(`  新規 ${r.area}×${r.genre}: ${r.entries.length}件`);

  const ingestOut = ingestCli({ payloadFile, tokenFile, dryRun: true });
  let ingestSent = null;
  if (doIngest && !dryOnly) {
    ingestSent = ingestCli({ payloadFile, tokenFile, dryRun: false });
  } else {
    log(doIngest && dryOnly ? "dry-run 指定のため本番取り込みはしていません" : "検証（dry-run）のみ。本番取り込みは --ingest を付けてください");
  }
  return { outDir, payloadFile, payload, result, kinds, comps, rankings, opens, ingestOut, ingestSent };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runPublicFetch(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
