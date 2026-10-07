import type { SourceMeta, Store } from "../types";
import { keyLabel } from "../lib/store-selection";

type Props = {
  stores: Store[];
  sources: SourceMeta[];
  loading: boolean;
  error: string | null;
  onSelect: (scope: string) => void;
  onManage?: () => void;
  onRetry: () => void;
};

// ログイン後の店舗の選択。「全店舗」は全店舗の比較ページを開く。選択はこのブラウザに保存される（表示の絞り込みのみ）。
export default function StoreSelect({ stores, sources, loading, error, onSelect, onManage, onRetry }: Props) {
  const names = new Map(sources.map((s) => [s.id, s]));
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4" aria-label="店舗の選択">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold tracking-tight">店舗を選択してください</h2>
          <p className="mt-1 text-[12px] text-subtle">選んだ店舗のデータだけを各画面に表示します。選択はこのブラウザに保存され、画面上部からいつでも切り替えられます。</p>
        </div>
        {onManage && <button onClick={onManage} className="rounded-md border border-line bg-card px-3 py-2 text-[12px] font-bold text-subtle hover:text-ink">店舗管理</button>}
      </div>
      {error ? (
        <p className="rounded-md bg-danger-soft px-4 py-3 text-[12px] font-bold text-danger">⚠ {error} <button onClick={onRetry} className="ml-2 underline">再読み込み</button></p>
      ) : null}
      <button onClick={() => onSelect("all")}
        className="flex items-center gap-4 rounded-md border-2 border-brand bg-brand-soft px-5 py-4 text-left transition hover:opacity-90">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand text-[18px] font-bold text-white">全</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold text-brand">全店舗</span>
          <span className="mt-0.5 block text-[11px] text-subtle">全店舗の比較表（PV・前月比・予約・評価・口コミ・未返信）と、全店舗合計のダッシュボード</span>
        </span>
        <span className="text-[12px] font-bold text-brand">開く →</span>
      </button>
      {loading ? (
        <p className="rounded-md border border-line bg-card px-6 py-10 text-center text-[12px] font-semibold text-faint">読み込み中…</p>
      ) : stores.length ? (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {stores.map((s) => (
            <li key={s.id}>
              <button onClick={() => onSelect(s.id)} className="flex h-full w-full flex-col gap-2 rounded-md border border-line bg-card px-4 py-3 text-left transition hover:border-brand">
                <span className="text-[13px] font-bold">{s.name}</span>
                <span className="flex flex-wrap gap-1">
                  {s.sites.length ? s.sites.map((x) => (
                    <span key={x.id} className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-subtle">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: names.get(x.source)?.color ?? "#cbd5e1" }} />
                      {names.get(x.source)?.name ?? x.source} {keyLabel(x.source, x.siteStoreKey)}
                    </span>
                  )) : <span className="text-[10px] text-faint">サイトの店舗ID未設定</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-md border border-line bg-card px-6 py-10 text-center text-[12px] text-subtle">
          {onManage ? <>店舗が登録されていません。<button onClick={onManage} className="ml-1 font-bold text-brand underline">店舗管理</button>で店舗と各サイトの店舗IDを登録してください。</> : "閲覧できる店舗がありません。管理者に店舗の割り当てをご依頼ください。"}
        </div>
      )}
    </section>
  );
}
