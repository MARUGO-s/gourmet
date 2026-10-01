#!/usr/bin/env node
// 管理画面のページの保存HTML（まだ解析していない分析・統計・予約・プランのページ）を agent-api（POST /pages/ingest）へ送る。
//   一覧: node scripts/page-snapshots.mjs list --source ikyu --store 112789     （ログイン1回で保存するページ・URL。当月・前月）
//   送信: INGEST_TOKEN=... node scripts/page-snapshots.mjs send --manifest DIR/pages.json [--dry-run] [--endpoint URL] [--token-file PATH]
// manifest: { "source": "ikyu"|"tabelog", "storeKey": "112789", "capturedAt": "ISO", "runKey": "任意",
//             "pages": [{ "page": "ikyu_reservations", "period": "2026-10-01", "url": "https://...", "file": "reservations.html" }] }
// 保存先は service_role だけが読める表。HTML・トークンは標準出力に出さない（ページ名・期間・バイト数だけ）。
// 解析済みのページ（status=parsed）は従来どおり ikyu-html-to-json.mjs / tabelog-html-to-json.mjs → agent-ingest.mjs で送る。
import fs from "node:fs";
import path from "node:path";
import { decodeHtml } from "./ikyu/html-lite.js";
import { SNAPSHOT_LIMITS, normalizePageSnapshots, pageInfo, routinePageList } from "../supabase/functions/_shared/page-snapshots.js";
import { parseArgs, readToken, callAgentApi, DEFAULT_ENDPOINT } from "./agent-common.mjs";

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const jstDay = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

try {
  if (cmd === "list") {
    const source = String(args.source ?? "");
    const store = String(args.store ?? "");
    const list = routinePageList(source, store);
    if (!list.length) throw new Error("--source は ikyu か tabelog です");
    for (const p of list) console.log([p.status === "parsed" ? "解析" : "保存", p.pii ? "個人情報" : "-", p.page, p.period, p.url, p.title].join("\t"));
    process.exit(0);
  }
  if (cmd !== "send" || typeof args.manifest !== "string") {
    console.error("使い方: page-snapshots.mjs list --source ikyu|tabelog --store ID / send --manifest pages.json [--dry-run]");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const base = path.dirname(path.resolve(args.manifest));
  const capturedAt = manifest.capturedAt ?? new Date().toISOString();
  const runKey = manifest.runKey ?? `pages-${manifest.source}-${manifest.storeKey || "default"}-${capturedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const pages = (manifest.pages ?? []).map((p) => {
    const info = pageInfo(manifest.source, p.page);
    if (!info) throw new Error(`カタログに無いページです: ${p.page}`);
    if (info.status === "parsed") throw new Error(`${p.page} は解析済みのページです（*-html-to-json.mjs → agent-ingest.mjs で送る）`);
    const { html } = decodeHtml(fs.readFileSync(path.resolve(base, p.file)));
    return { source: manifest.source, storeKey: String(manifest.storeKey ?? ""), page: p.page, period: p.period === "today" || !p.period ? jstDay() : p.period, url: p.url, html };
  });
  // 合計の上限・件数の上限ごとに分けて送る
  const batches = [];
  let cur = [], bytes = 0;
  for (const p of pages) {
    const b = Buffer.byteLength(p.html);
    if (cur.length && (cur.length >= SNAPSHOT_LIMITS.pagesPerRequest || bytes + b > SNAPSHOT_LIMITS.requestBytes)) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(p); bytes += b;
  }
  if (cur.length) batches.push(cur);
  let saved = 0, changed = 0;
  for (const [i, batch] of batches.entries()) {
    const payload = { schemaVersion: 1, runKey: batches.length > 1 ? `${runKey}.${i + 1}` : runKey, capturedAt, pages: batch };
    const rows = normalizePageSnapshots(payload);
    console.log(`検証OK（${i + 1}/${batches.length}）: ${rows.map((r) => `${r.page} ${r.period} ${r.bytes}B${r.contains_pii ? "（個人情報）" : ""}`).join(" / ")}`);
    if (args["dry-run"]) continue;
    const { status, body } = await callAgentApi("/pages/ingest", payload, { endpoint: args.endpoint || process.env.AGENT_API_URL || DEFAULT_ENDPOINT, token: readToken(args) });
    if (status !== 200) throw new Error(`保存に失敗しました（HTTP ${status}）: ${body.error ?? ""}`);
    saved += body.saved ?? 0; changed += body.changed ?? 0;
  }
  if (!args["dry-run"]) console.log(`保存完了: ${saved}ページ（内容が変わったページ ${changed}）`);
} catch (error) {
  console.error(`ページを保存できませんでした: ${error.message}`);
  process.exit(1);
}
