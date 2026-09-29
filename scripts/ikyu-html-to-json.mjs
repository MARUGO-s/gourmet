#!/usr/bin/env node
// 保存した一休の管理画面HTMLを取り込み形式（schemaVersion 1）のJSONへ変換する。ネットワークには接続しない。
//   単一店舗: node scripts/ikyu-html-to-json.mjs --store 112789 --pv 2026-09=pv-2026-09.html --pv 2026-08=pv-2026-08.html \
//               --reviews rv-p1.html --reviews rv-p2.html --out payload.json
//   複数店舗: node scripts/ikyu-html-to-json.mjs --manifest manifest.json --out payload.json
//     manifest: {"runId":"...","stores":[{"storeId":"112789","name":null,"pv":{"2026-09":"pv.html"},"reviews":["p1.html"],
//                "public":{"store":"public-top.html","reviews":["public-reviews-1.html"]}}]}
//   公開ページ（restaurant.ikyu.com/<店舗ID> と /reviews）: --public-store top.html --public-reviews reviews-1.html
// HTMLは Shift_JIS / UTF-8 を自動判定する（meta charset → UTF-8検証 → Shift_JIS）。
import fs from "node:fs";
import path from "node:path";
import { decodeHtml } from "./ikyu/html-lite.js";
import { buildIkyuStore, buildIkyuPayload } from "./ikyu/parse.js";
import { buildIkyuPublic } from "./ikyu/public.js";
import { normalizeIkyuIngest } from "../supabase/functions/_shared/ikyu-data.js";
import { parseArgs } from "./agent-common.mjs";

const args = parseArgs(process.argv.slice(2));
const list = (v) => (v === undefined ? [] : [].concat(v));
const read = (file, base = ".") => decodeHtml(fs.readFileSync(path.resolve(base, file))).html;

let spec;
if (args.manifest) {
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const base = path.dirname(path.resolve(args.manifest));
  spec = { runId: manifest.runId, warning: manifest.warning, stores: manifest.stores.map((s) => ({
    storeId: String(s.storeId), name: s.name ?? null,
    pvPages: Object.entries(s.pv ?? {}).map(([month, file]) => ({ month, html: read(file, base) })),
    reviewPages: (s.reviews ?? []).map((file) => read(file, base)),
    public: s.public ? { store: s.public.store ? read(s.public.store, base) : "", reviews: (s.public.reviews ?? []).map((file) => read(file, base)) } : null,
  })) };
} else {
  if (!/^\d{6}$/.test(String(args.store ?? ""))) { console.error("--store（6桁の店舗ID）または --manifest を指定してください"); process.exit(2); }
  spec = { runId: args["run-id"], warning: args.warning, stores: [{
    storeId: String(args.store), name: typeof args.name === "string" ? args.name : null,
    pvPages: list(args.pv).map((v) => { const [month, file] = String(v).split(/=(.*)/s); return { month, html: read(file) }; }),
    reviewPages: list(args.reviews).map((file) => read(file)),
    public: args["public-store"] || args["public-reviews"] ? { store: args["public-store"] ? read(args["public-store"]) : "", reviews: list(args["public-reviews"]).map((file) => read(file)) } : null,
  }] };
}
try {
  const stores = spec.stores.map((s) => {
    const store = buildIkyuStore(s.storeId, s);
    return s.public ? { ...store, public: buildIkyuPublic(s.storeId, s.public.store, s.public.reviews) } : store;
  });
  const payload = buildIkyuPayload({ runId: spec.runId || `ikyu-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`, warning: spec.warning, stores });
  const checked = normalizeIkyuIngest(payload); // 送信前に同じ検証を行う
  const json = JSON.stringify(payload, null, 2);
  if (args.out) fs.writeFileSync(args.out, json); else process.stdout.write(`${json}\n`);
  for (const s of checked.stores) console.error(`店舗${s.store_id}${s.name ? `（${s.name}）` : ""}: 日別PV ${s.days.length}日 / ${s.months.length}か月 / 口コミ ${s.reviews.length}件（要返信 ${s.reviews.filter((r) => r.needs_reply).length}件）${s.public ? ` / 公開評価 ${s.public.rating?.toFixed(2) ?? "—"}・公開口コミ ${s.public.reviews.length}件` : ""}`);
  if (checked.skippedDays) console.error(`当日以降の${checked.skippedDays}日分は集計中のため保存対象外です`);
} catch (error) {
  console.error(`変換できませんでした: ${error.message}`);
  process.exit(1);
}
