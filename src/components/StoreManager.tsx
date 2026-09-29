import { useEffect, useState } from "react";
import { addStoreSite, createStore, deleteStore, deleteStoreSite, getOverview, reorderStores, updateStore } from "../api";
import type { OverviewRow, SourceMeta, Store } from "../types";
import { STORE_SOURCES, siteKeyError } from "../../supabase/functions/_shared/stores.js";
import { keyLabel } from "../lib/store-selection";

type Props = { stores: Store[]; sources: SourceMeta[]; onChanged: () => void };
const input = "rounded border border-line bg-card px-2 py-1.5 text-[12px] font-semibold focus:border-brand focus:outline-none";

// 店舗管理: 店舗の追加・名前の変更・並び替え・削除と、店舗ごとの各サイトの店舗ID（一休の6桁の店舗ID、食べログの店舗コード など）
export default function StoreManager({ stores, sources, onChanged }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState<Record<string, { source: string; key: string }>>({});
  const [unassigned, setUnassigned] = useState<OverviewRow | null>(null);
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});
  const names = new Map(sources.map((s) => [s.id, s]));

  useEffect(() => {
    let alive = true;
    getOverview().then(({ overview }) => { if (alive) setUnassigned(overview.unassigned); }).catch(() => { if (alive) setUnassigned(null); });
    return () => { alive = false; };
  }, [stores]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ text: done, error: false });
      onChanged();
      return true;
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "保存できませんでした", error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: number) => {
    const ids = stores.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(() => reorderStores(ids), "並び順を保存しました");
  };

  const addSite = async (store: Store) => {
    const draft = adding[store.id] ?? { source: STORE_SOURCES[0], key: "" };
    const key = draft.key.trim();
    const error = siteKeyError(draft.source, key);
    if (error) { setNotice({ text: error, error: true }); return; }
    if (await run(() => addStoreSite(store.id, { source: draft.source, siteStoreKey: key }), `${store.name}に${names.get(draft.source)?.name ?? draft.source}（${keyLabel(draft.source, key)}）を設定しました`)) {
      setAdding((a) => ({ ...a, [store.id]: { source: draft.source, key: "" } }));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-md border border-line bg-card p-5">
        <h2 className="text-[13px] font-bold">店舗管理</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-subtle">
          店舗ごとに、各サイトの店舗ID（一休は6桁の店舗ID、食べログは店舗コード など）をまとめます。店舗を選ぶと、その店舗IDのデータ・アカウント・取得依頼・自動取得の設定だけを表示します（表示の切り替えで、店長ごとの権限ではありません）。
          店舗コードを入力せずに登録したアカウントや、以前のアプリ内取得のデータは「既定（コードなし）」です。同じサイトの店舗IDは1つの店舗にだけ設定できます。
        </p>
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => createStore({ name }), `「${name.trim()}」を追加しました`).then((ok) => { if (ok) setName(""); }); }}>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-subtle">店舗名
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="例: BISTRO CAVACAVA" className={`${input} w-64`} />
          </label>
          <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-brand px-3.5 py-2 text-[12px] font-bold text-white disabled:opacity-50">店舗を追加</button>
        </form>
        {notice ? <p className={`mt-3 rounded px-3 py-2 text-[11px] font-bold ${notice.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{notice.error ? "⚠" : "✓"} {notice.text}</p> : null}
      </section>

      {unassigned ? (
        <section className="rounded-md border border-warn bg-card p-5">
          <h3 className="text-[12px] font-bold text-warn">未割り当てのサイトの店舗ID</h3>
          <p className="mt-1 text-[11px] text-subtle">データまたはアカウントがあり、どの店舗にも設定されていない店舗IDです（全店舗の比較では「未割り当て」に表示されます）。</p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {Object.entries(unassigned.sites).flatMap(([source, site]) => site.keys.map((k) => {
              const id = `${source}/${k.key}`;
              return (
                <li key={id} className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="inline-flex items-center gap-1.5 font-bold"><span className="h-2 w-2 rounded-full" style={{ background: names.get(source)?.color ?? "#cbd5e1" }} />{names.get(source)?.name ?? source}</span>
                  <span>{keyLabel(source, k.key)}{k.name ? <span className="ml-1 text-faint">（{k.name}）</span> : null}</span>
                  <select aria-label="割り当てる店舗" value={assignTo[id] ?? ""} onChange={(e) => setAssignTo({ ...assignTo, [id]: e.target.value })} className={input}>
                    <option value="">店舗を選択</option>
                    {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button disabled={busy || !assignTo[id]} onClick={() => void run(() => addStoreSite(assignTo[id], { source, siteStoreKey: k.key }), "割り当てました")}
                    className="rounded border border-brand px-2 py-1 text-[11px] font-bold text-brand disabled:opacity-50">割り当てる</button>
                </li>
              );
            }))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-md border border-line bg-card">
        <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <h3 className="text-[13px] font-bold tracking-tight">店舗一覧</h3>
          <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{stores.length} 店舗</span>
        </header>
        <ul className="divide-y divide-line">
          {stores.map((s, i) => {
            const draft = adding[s.id] ?? { source: STORE_SOURCES[0], key: "" };
            return (
              <li key={s.id} className="flex flex-col gap-2 px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 text-right text-[11px] font-bold text-faint">{i + 1}</span>
                  {editing?.id === s.id ? (
                    <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); void run(() => updateStore(s.id, { name: editing.name }), "店舗名を変更しました").then((ok) => { if (ok) setEditing(null); }); }}>
                      <input autoFocus value={editing.name} onChange={(e) => setEditing({ id: s.id, name: e.target.value })} maxLength={100} className={`${input} w-60`} aria-label="店舗名" />
                      <button type="submit" disabled={busy} className="rounded bg-brand px-2 py-1 text-[11px] font-bold text-white">保存</button>
                      <button type="button" onClick={() => setEditing(null)} className="rounded border border-line px-2 py-1 text-[11px] font-bold text-subtle">取消</button>
                    </form>
                  ) : (
                    <span className="text-[13px] font-bold">{s.name}</span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <button aria-label="上へ" disabled={busy || i === 0} onClick={() => move(i, -1)} className="rounded border border-line px-2 py-1 text-[11px] disabled:opacity-30">↑</button>
                    <button aria-label="下へ" disabled={busy || i === stores.length - 1} onClick={() => move(i, 1)} className="rounded border border-line px-2 py-1 text-[11px] disabled:opacity-30">↓</button>
                    <button disabled={busy} onClick={() => setEditing({ id: s.id, name: s.name })} className="rounded border border-line px-2 py-1 text-[11px] font-bold text-subtle">名前を変更</button>
                    <button disabled={busy} onClick={() => {
                      if (window.confirm(`「${s.name}」を削除しますか？（アカウント・取得依頼・取り込みデータは削除されず、「未割り当て」に表示されます）`)) void run(() => deleteStore(s.id), "店舗を削除しました");
                    }} className="rounded px-2 py-1 text-[11px] font-bold text-danger hover:bg-danger-soft">削除</button>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pl-8">
                  {s.sites.map((x) => (
                    <span key={x.id} className="inline-flex items-center gap-1 rounded bg-surface px-2 py-1 text-[11px] font-semibold">
                      <span className="h-2 w-2 rounded-full" style={{ background: names.get(x.source)?.color ?? "#cbd5e1" }} />
                      {names.get(x.source)?.name ?? x.source}：{keyLabel(x.source, x.siteStoreKey)}
                      <button aria-label="この店舗IDの設定を外す" disabled={busy} onClick={() => void run(() => deleteStoreSite(s.id, x.id), "店舗IDの設定を外しました")} className="ml-0.5 text-faint hover:text-danger">×</button>
                    </span>
                  ))}
                  <form className="inline-flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void addSite(s); }}>
                    <select aria-label="サイト" value={draft.source} onChange={(e) => setAdding({ ...adding, [s.id]: { source: e.target.value, key: "" } })} className={input}>
                      {STORE_SOURCES.map((id) => <option key={id} value={id}>{names.get(id)?.name ?? id}</option>)}
                    </select>
                    <input aria-label="店舗ID" value={draft.key} onChange={(e) => setAdding({ ...adding, [s.id]: { ...draft, key: e.target.value.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40) } })}
                      placeholder={draft.source === "ikyu" ? "6桁の店舗ID" : "店舗コード（空欄=既定）"} className={`${input} w-40`} />
                    <button type="submit" disabled={busy} className="rounded border border-brand px-2 py-1 text-[11px] font-bold text-brand disabled:opacity-50">設定</button>
                  </form>
                </div>
              </li>
            );
          })}
          {!stores.length ? <li className="px-5 py-8 text-center text-[12px] text-faint">店舗が登録されていません。上の欄から追加してください。</li> : null}
        </ul>
      </section>
    </div>
  );
}
