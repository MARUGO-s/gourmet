import { SOURCE_IDS } from "./sources.js";

// 未指定は従来どおり全サイト。空の指定を「全サイト」と解釈しない。
export function validateSourceSelection(value) {
  if (value == null) return [...SOURCE_IDS];
  if (!Array.isArray(value) || !value.length || value.length > SOURCE_IDS.length ||
      value.some(id => !SOURCE_IDS.includes(id)) || new Set(value).size !== value.length) {
    throw new Error("分析するサイトを1つ以上、正しく選択してください");
  }
  return SOURCE_IDS.filter(id => value.includes(id));
}

// モデルへの前提・集計・特殊ツール・鮮度を同じ対象にそろえる。RLSは読み込み時に適用済み。
export function selectAnalystSources(ds, selection) {
  const selectedSources = validateSourceSelection(selection ?? ds.selectedSources);
  if (selectedSources.length === SOURCE_IDS.length) return { ...ds, selectedSources };
  const allowed = new Set(selectedSources);
  const out = { ...ds, selectedSources };
  for (const key of ["sites", "daily", "legacy", "monthly", "current", "reviews", "sourceDaily", "sourceMonthly", "reports", "freshness"]) {
    out[key] = (ds[key] ?? []).filter(row => allowed.has(row.source));
  }
  for (const key of ["ikyuDaily", "ikyuMonthly"]) out[key] = allowed.has("ikyu") ? ds[key] ?? [] : [];
  return out;
}
