// 画面の店舗の選択（ブラウザの localStorage に利用者ごとに保存）。表示の絞り込みだけで、権限ではない。
import { ALL_STORES } from "../../supabase/functions/_shared/stores.js";
import type { Store } from "../types";

const storageKey = (userId: string) => `gourmet.selectedStore.${userId}`;

// 保存済みの選択（'all' か、現在も存在する店舗ID）。無ければ null（店舗の選択画面を表示）
export function loadSelection(userId: string, stores: Store[]): string | null {
  let value: string | null = null;
  try { value = window.localStorage.getItem(storageKey(userId)); } catch { value = null; }
  if (value === ALL_STORES) return ALL_STORES;
  return value && stores.some((s) => s.id === value) ? value : null;
}
export function saveSelection(userId: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(storageKey(userId), value);
    else window.localStorage.removeItem(storageKey(userId));
  } catch { /* 保存できない環境（プライベートモード等）では毎回選択する */ }
}

// 店舗に割り当てた、そのサイトの店舗コード
export const siteKeysOf = (store: Store | undefined, source: string) =>
  (store?.sites ?? []).filter((s) => s.source === source).map((s) => s.siteStoreKey);
export const keyLabel = (source: string, key: string) => (key ? (source === "ikyu" ? `店舗ID ${key}` : key) : "既定（コードなし）");
