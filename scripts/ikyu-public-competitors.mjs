#!/usr/bin/env node
// 一休の週報「競合比較」の比較店スナップショット（ikyu-competitors.json）を作る。
// 比較店は scripts/ikyu/competitors-config.json（店舗ごと）。一休の公開ページ（restaurant.ikyu.com/<店舗ID>/）だけを読む。
// 管理画面・ログインページは使わない。通常のブラウザ UA の HTTP 取得、間隔 2.5 秒以上、リダイレクトは辿らない。
// 403・429・503・追加認証（CAPTCHA）が出たら回避せず止める（CAPTCHA 解決サービスは使わない）。
//
//   node scripts/ikyu-public-competitors.mjs --store 112789 [--out-dir /workspace/run-YYYYMMDD-ikyu-public] [--delay-ms 2500]
//   node scripts/ikyu-public-competitors.mjs --store 112789 --from-dir /workspace/run-YYYYMMDD-ikyu-public   # 保存済み HTML だけ（ネットワークなし）
//
// 保存: <out-dir>/store-<店舗ID>.html（自店も store-112789.html）と <out-dir>/ikyu-competitors.json。
// weekly-assemble.mjs --runs-dir は ikyu-competitors.json を探し、作成日以前・14日以内の最新を一休の競合比較に使う。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./agent-common.mjs";
import { COMPETITORS_FILE, buildCompetitorSnapshot, competitorConfig, publicUrl } from "./ikyu/competitors.js";
import { DEFAULT_DELAY_MS, PUBLIC_FETCH_UA, isBlockedPublicPage } from "./tabelog/public-payload.js";

const japanDay = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MAX_REQUESTS = 20;

async function fetchIkyuPage(url, { fetcher }) {
  if (!/^https:\/\/restaurant\.ikyu\.com\/[1-9][0-9]{5}\/$/.test(url)) throw new Error(`一休の公開店舗ページ以外は取得しません: ${url}`);
  const res = await fetcher(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": PUBLIC_FETCH_UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "Accept-Language": "ja,en-US;q=0.9,en;q=0.8" },
  });
  const html = Buffer.from(await res.arrayBuffer()).toString("utf8");
  if (res.status >= 300 && res.status < 400) throw new Error(`リダイレクトを辿りません（HTTP ${res.status}）: ${url}`);
  const blocked = isBlockedPublicPage({ status: res.status, html, title: html.match(/<title>([^<]*)/i)?.[1] ?? "" });
  if (blocked) throw new Error(`公開ページが制限されました（${blocked}）。回避せず停止しました: ${url}`);
  if (res.status !== 200) throw new Error(`公開ページが HTTP ${res.status} を返しました: ${url}`);
  return html;
}

export async function runIkyuPublicCompetitors(argv, { fetcher = fetch, log = console.error, now = new Date(), configFile, wait = sleep } = {}) {
  const args = parseArgs(argv);
  const storeId = String(args.store ?? "");
  if (!/^[1-9][0-9]{5}$/.test(storeId)) throw new Error("--store（一休の店舗ID 6桁）を指定してください");
  const config = competitorConfig(storeId, configFile ? { file: configFile } : {});
  if (!config) throw new Error(`店舗 ${storeId} の比較店設定がありません（scripts/ikyu/competitors-config.json）`);
  const ids = [storeId, ...config.competitors.map((c) => c.storeId)];
  if (ids.length > MAX_REQUESTS) throw new Error(`比較店が多すぎます（${MAX_REQUESTS}ページまで）`);
  const day = japanDay(now);
  const fromDir = typeof args["from-dir"] === "string" ? args["from-dir"] : null;
  const outDir = typeof args["out-dir"] === "string" ? args["out-dir"] : fromDir ?? `/workspace/run-${day.replaceAll("-", "")}-ikyu-public`;
  const delayMs = Number.isFinite(Number(args["delay-ms"])) ? Math.max(DEFAULT_DELAY_MS, Number(args["delay-ms"])) : DEFAULT_DELAY_MS;
  fs.mkdirSync(outDir, { recursive: true });
  const pages = {};
  let capturedAt = now.toISOString();
  if (fromDir) {
    for (const id of ids) {
      const f = path.join(fromDir, `store-${id}.html`);
      if (fs.existsSync(f)) pages[id] = fs.readFileSync(f, "utf8");
    }
    const mtimes = ids.map((id) => path.join(fromDir, `store-${id}.html`)).filter((f) => fs.existsSync(f)).map((f) => fs.statSync(f).mtimeMs);
    if (mtimes.length) capturedAt = new Date(Math.min(...mtimes)).toISOString();
  } else {
    log(`一休の公開ページを取得します（${ids.length}ページ、間隔 ${delayMs}ms）`);
    for (const [i, id] of ids.entries()) {
      if (i) await wait(delayMs);
      const html = await fetchIkyuPage(publicUrl(id), { fetcher });
      fs.writeFileSync(path.join(outDir, `store-${id}.html`), html);
      pages[id] = html;
    }
  }
  const snap = buildCompetitorSnapshot({
    storeId, config, pages, ownHtml: pages[storeId] ?? null, capturedAt,
    runId: `ikyu-public-${day.replaceAll("-", "")}-${storeId}`,
  });
  const out = path.join(outDir, COMPETITORS_FILE);
  fs.writeFileSync(out, `${JSON.stringify(snap, null, 2)}\n`);
  log(`比較店 ${snap.competitors.length}店${snap.missing.length ? `（ページなし: ${snap.missing.join("・")}）` : ""} → ${out}`);
  return { file: out, snapshot: snap };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIkyuPublicCompetitors(process.argv.slice(2)).then(({ snapshot }) => {
    for (const c of snapshot.competitors) console.log(`${c.storeId}\t${c.name}\t${c.rating ?? "未取得"}\t${c.reviews ?? "未取得"}\t${c.price ?? "未取得"}`);
  }).catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
}
