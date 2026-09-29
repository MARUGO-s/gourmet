import type { Store } from "../types";

// 画面上部の店舗の切り替え（全店舗 / 各店舗）。「店舗を選び直す」で選択画面へ戻る。
export default function StoreSwitcher({ stores, scope, onChange, onReselect }: { stores: Store[]; scope: string; onChange: (scope: string) => void; onReselect: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="store-switcher">表示する店舗</label>
      <select id="store-switcher" value={scope} onChange={(e) => onChange(e.target.value)}
        className="max-w-[220px] rounded-md border border-brand bg-brand-soft px-2.5 py-2 text-[12px] font-bold text-brand focus:outline-none">
        <option value="all">全店舗</option>
        {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button onClick={onReselect} title="店舗の選択画面に戻ります" className="rounded-md border border-line px-2 py-2 text-[11px] font-bold text-subtle hover:text-ink">選び直す</button>
    </div>
  );
}
