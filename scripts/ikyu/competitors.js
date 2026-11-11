// エージェント側（Grok Bot）専用: 一休の週報の「競合比較」。設定（competitors-config.json）で選んだ比較店の
// 公開ページ（restaurant.ikyu.com/<店舗ID>/ の保存 HTML）から、評価・口コミ数・価格帯・最寄駅だけを読む。
// 一休の公開ページは評価数が規定に満たない店で評価を出さない（「規定評価数に達していません」）→ 評価は null（未取得）。
// ネットワークには接続しない（取得は scripts/ikyu-public-competitors.mjs）。お客様の口コミ本文・投稿者名は読まない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIkyuPublic } from "./public.js";
import { decodeEntities } from "./html-lite.js";

export const COMPETITORS_KIND = "ikyu_public_competitors";
export const COMPETITORS_FILE = "ikyu-competitors.json";
const STORE_ID = /^[1-9][0-9]{5}$/;
const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "competitors-config.json");

/** 店舗の比較店設定（無ければ null） */
export function competitorConfig(storeId, { file = CONFIG_FILE } = {}) {
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg = all?.stores?.[String(storeId)];
  if (!cfg) return null;
  const list = (cfg.competitors ?? []).filter((c) => STORE_ID.test(String(c?.storeId)) && String(c.storeId) !== String(storeId));
  return { ...cfg, competitors: list.map((c) => ({ storeId: String(c.storeId), category: c.category ?? null })) };
}

export const publicUrl = (storeId) => `https://restaurant.ikyu.com/${storeId}/`;

const text = (html) => decodeEntities(String(html)
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, " ")
  .replace(/<[^>]+>/g, "|"))
  .replace(/\s*\|[\s|]*/g, "|");

/** 公開ページ（店舗トップ）→ 比較用の1行。読めない項目は null（未取得）。 */
export function parseCompetitorPage(storeId, html) {
  if (!STORE_ID.test(String(storeId))) throw new Error("店舗IDは6桁の数字です");
  const s = String(html ?? "");
  const title = decodeEntities(s.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "").trim();
  const head = title.match(/^(.*?) - ([^/[]+)\/([^[]+?)\s*\[一休\.comレストラン\]$/);
  if (!head) throw new Error(`一休の店舗ページではありません（${storeId}）`);
  const { rating, reviews } = parseIkyuPublic(String(storeId), s, "");
  const t = text(s);
  const belowMin = /規定評価数に達していません/.test(t);
  // 評価が出ていない店の件数表示（「規定評価数に達していません（1件）」）
  const countOnly = belowMin && reviews == null ? Number(t.match(/規定評価数に達していません\|?（\|?(\d+)\|?件）/)?.[1]) : null;
  const price = decodeEntities(s.match(/itemProp="priceRange"[^>]*content="([^"]*)"/i)?.[1] ?? "").replace(/\s+/g, " ").trim() || null;
  const dinner = price?.match(/夜：([^ 　]+)/)?.[1] ?? null;
  const lunch = price?.match(/昼：([^ 　]+)/)?.[1] ?? null;
  // 店舗情報の最初の「〇〇駅［ 出口・徒歩］」（例: 四ツ谷駅 徒歩1分 / 曙橋駅 A3出口から徒歩2分 / 四谷三丁目駅）
  const station = t.match(/\|([^|\s]{1,20}駅)(?:\s([^|]{1,30}?))?\|/);
  return {
    storeId: String(storeId),
    name: head[1].trim(),
    area: head[2].trim(),
    genre: head[3].trim(),
    rating: belowMin ? null : rating,
    ratingNote: belowMin ? "規定評価数未満（一休が評価を非表示）" : null,
    reviews: Number.isInteger(reviews) ? reviews : Number.isInteger(countOnly) ? countOnly : null,
    price, priceDinner: dinner, priceLunch: lunch,
    station: station ? [station[1], station[2]?.replace(/\s+/g, "")].filter(Boolean).join(" ") : null,
    url: publicUrl(storeId),
  };
}

/** 比較店スナップショット（ikyu-competitors.json） */
export function buildCompetitorSnapshot({ storeId, config, pages, ownHtml = null, capturedAt = new Date().toISOString(), runId }) {
  if (!config) throw new Error(`店舗 ${storeId} の比較店設定がありません（scripts/ikyu/competitors-config.json）`);
  const rows = [], missing = [];
  for (const c of config.competitors) {
    const html = pages[c.storeId];
    if (!html) { missing.push(c.storeId); continue; }
    rows.push({ ...parseCompetitorPage(c.storeId, html), category: c.category });
  }
  return {
    kind: COMPETITORS_KIND, schemaVersion: 1, source: "ikyu", agent: "grok-bot", runId, capturedAt,
    storeId: String(storeId), areaLabel: config.areaLabel ?? null, selection: config.selection ?? null,
    own: ownHtml ? parseCompetitorPage(String(storeId), ownHtml) : null,
    competitors: rows, missing,
  };
}

/** スナップショットとして受け付けない理由（null = よい） */
export function competitorSnapshotProblem(snap, storeId) {
  if (!snap || snap.kind !== COMPETITORS_KIND || snap.schemaVersion !== 1) return "一休の比較店スナップショットではありません";
  if (String(snap.storeId) !== String(storeId)) return "店舗が違います";
  if (typeof snap.runId !== "string" || !/^ikyu-public-\d{8,}/.test(snap.runId)) return "runId が取得の形ではありません";
  if (!Number.isFinite(Date.parse(snap.capturedAt))) return "capturedAt がありません";
  if (!Array.isArray(snap.competitors) || !snap.competitors.length) return "比較店がありません";
  if (snap.competitors.some((c) => !STORE_ID.test(String(c?.storeId)) || !c.name)) return "比較店の行が不正です";
  return null;
}

/** 週報の入力（competitors 行）。自店を先頭に、比較店は評価の高い順（評価なしは後ろ）。 */
export function competitorRows(snap, { ownName, ownProfile = {} } = {}) {
  const own = { own: true, name: ownName ?? snap.own?.name ?? "自店", rating: ownProfile.rating ?? snap.own?.rating ?? null, reviews: ownProfile.reviewCount ?? snap.own?.reviews ?? null, price: snap.own?.price ?? null, station: snap.own?.station ?? null, genre: snap.own?.genre ?? null };
  const others = [...snap.competitors].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.reviews ?? -1) - (a.reviews ?? -1))
    .map((c) => ({ own: false, name: c.name, rating: c.rating ?? null, reviews: c.reviews ?? null, price: c.price ?? null, station: c.station ?? null, genre: c.category ?? c.genre ?? null, ratingNote: c.ratingNote ?? null, url: c.url }));
  return [own, ...others];
}
