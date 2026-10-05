import { addStoreSite } from "../api";
import type { Store } from "../types";
import { siteKeyError } from "../../supabase/functions/_shared/stores.js";
import { keyLabel, siteKeysOf } from "../lib/store-selection";

// 店舗（店舗マスタ）の選択と、そのサイトの店舗ID。店舗IDは「店舗管理」の割り当てを使い、未設定ならその場で入力して割り当てに保存する。
export type StorePick = { storeId: string; key: string; typed: string };
export const emptyPick = (storeId = ""): StorePick => ({ storeId, key: "", typed: "" });
const NOT_ASSIGNED = "この店舗にはこのサイトの店舗IDが設定されていません。持ち主・管理者に「店舗管理」での設定を依頼してください";

// canAssign=false（チームのメンバー）: 未設定の店舗IDをその場で割り当てない（店舗管理は持ち主・管理者だけ）
export function resolvePick(stores: Store[], source: string, pick: StorePick, { canAssign = true }: { canAssign?: boolean } = {}): { key: string; isNew: boolean; error: string | null } {
  const store = stores.find((s) => s.id === pick.storeId);
  if (!store) return { key: "", isNew: false, error: "店舗を選択してください" };
  const keys = siteKeysOf(store, source);
  if (keys.length) return { key: keys.includes(pick.key) ? pick.key : keys[0], isNew: false, error: null };
  if (!canAssign) return { key: "", isNew: false, error: NOT_ASSIGNED };
  const key = pick.typed.trim();
  return { key, isNew: true, error: siteKeyError(source, key) };
}

// 未設定の店舗IDを店舗の割り当てに保存してから、その店舗コードを返す（保存できなければ例外）
export async function commitPick(stores: Store[], source: string, pick: StorePick, options: { canAssign?: boolean } = {}): Promise<{ key: string; created: boolean }> {
  const r = resolvePick(stores, source, pick, options);
  if (r.error) throw new Error(r.error);
  if (r.isNew) await addStoreSite(pick.storeId, { source, siteStoreKey: r.key });
  return { key: r.key, created: r.isNew };
}

type Props = {
  stores: Store[];
  source: string;
  sourceName: string;
  value: StorePick;
  onChange: (v: StorePick) => void;
  compact?: boolean;
  canAssign?: boolean;
};

export default function StorePicker({ stores, source, sourceName, value, onChange, compact, canAssign = true }: Props) {
  const store = stores.find((s) => s.id === value.storeId);
  const keys = siteKeysOf(store, source);
  const box = compact ? "rounded border border-line bg-card px-2 py-1.5 font-normal text-ink" : "rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold focus:border-brand focus:outline-none";
  const label = compact ? "flex flex-col gap-1 font-bold text-subtle" : "flex flex-col gap-1.5 text-[11px] font-bold text-subtle";
  return (
    <>
      <label className={label}>店舗
        <select value={value.storeId} onChange={(e) => onChange(emptyPick(e.target.value))} className={box}>
          <option value="">店舗を選択</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {store ? (
        keys.length > 1 ? (
          <label className={label}>{sourceName}の{source === "ikyu" ? "店舗ID" : "店舗コード"}
            <select value={keys.includes(value.key) ? value.key : keys[0]} onChange={(e) => onChange({ ...value, key: e.target.value })} className={box}>
              {keys.map((k) => <option key={k} value={k}>{keyLabel(source, k)}</option>)}
            </select>
          </label>
        ) : keys.length === 1 ? (
          <p className={compact ? "self-end pb-1.5 text-[11px] text-subtle" : "text-[11px] text-subtle"}>{sourceName}：{keyLabel(source, keys[0])}<span className="ml-1 text-faint">（店舗管理で設定）</span></p>
        ) : !canAssign ? (
          <p className={compact ? "self-end pb-1.5 text-[11px] text-warn" : "text-[11px] text-warn"}>{NOT_ASSIGNED}</p>
        ) : (
          <label className={label}>{sourceName}の{source === "ikyu" ? "店舗ID（6桁・未設定）" : "店舗コード（未設定）"}
            <input value={value.typed} onChange={(e) => onChange({ ...value, typed: e.target.value.replace(source === "ikyu" ? /\D/g : /[^0-9A-Za-z_-]/g, "").slice(0, source === "ikyu" ? 6 : 40) })}
              inputMode={source === "ikyu" ? "numeric" : undefined} autoComplete="off"
              placeholder={source === "ikyu" ? "例: 112789（この店舗に保存します）" : "例: 13245351（未入力なら既定・この店舗に保存）"} className={box} />
          </label>
        )
      ) : null}
    </>
  );
}
