import { useCallback, useEffect, useState } from "react";
import { deleteCredential, getCredentials, saveCredential } from "../api";
import type { CredentialRow, SourceMeta, Store, StoreKeys } from "../types";
import { filterByStore, storeLabelFor } from "../../supabase/functions/_shared/stores.js";
import StorePicker, { commitPick, emptyPick, resolvePick } from "./StorePicker";

type Props = {
  sources: SourceMeta[];
  onChanged: () => void;
  // 店舗マスタ・表示中の店舗の店舗コード（null=全店舗）・新規登録の既定の店舗
  stores: Store[];
  scopeKeys: StoreKeys | null;
  defaultStoreId: string;
  onStoresChanged: () => void;
};

export default function CredentialsPanel({ sources, onChanged, stores, scopeKeys, defaultStoreId, onStoresChanged }: Props) {
  const [allRows, setRows] = useState<CredentialRow[]>([]);
  const rows = filterByStore(allRows, scopeKeys);
  const allSites = stores.flatMap((s) => s.sites);
  const [source, setSource] = useState<string>(sources[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [pick, setPick] = useState(emptyPick(defaultStoreId));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getCredentials().then(setRows).catch((e) => {
      setRows([]);
      setNotice(e instanceof Error ? e.message : "アカウント情報を取得できませんでした");
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!source && sources[0]) setSource(sources[0].id);
  }, [source, sources]);

  const srcMap = new Map(sources.map((s) => [s.id, s]));

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const resolved = resolvePick(stores, source, pick);
      if (resolved.error) { setNotice(resolved.error); return; }
      if (!source || !username || !password) {
        setNotice(source === "ikyu" ? "オペレータID・パスワードを入力してください" : "サイト / ID / パスワード を入力してください");
        return;
      }
      setSaving(true);
      setNotice(null);
      try {
        // 店舗IDが未設定なら、先に店舗の割り当てに保存する（別の店舗に割り当て済みならここで止まる）
        const { key, created } = await commitPick(stores, source, pick);
        if (created) onStoresChanged();
        await saveCredential({ source, label, username, password, ...(source === "ikyu" ? { storeId: key } : { storeKey: key }) });
        setLabel("");
        setPick(emptyPick(pick.storeId));
        setUsername("");
        setPassword("");
        setShowPassword(false);
        setNotice("保存しました");
        refresh();
        onChanged();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "保存に失敗しました");
      } finally {
        setSaving(false);
      }
    },
    [source, label, pick, stores, username, password, refresh, onChanged, onStoresChanged],
  );

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await deleteCredential(id);
        refresh();
        onChanged();
      } catch {
        setNotice("削除に失敗しました");
      }
    },
    [refresh, onChanged],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <section className="rounded-md border border-line bg-card">
        <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-bold tracking-tight">登録済みアカウント</h2>
          <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">
            {rows.length} 件
          </span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="border-b border-line">
                {["サイト", "店舗", "ラベル", "状態", "更新日時", ""].map((h) => (
                  <th key={h} className="px-5 py-2.5 text-[10px] font-bold tracking-wide text-faint uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = srcMap.get(r.source);
                return (
                  <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-surface">
                    <td className="px-5 py-2.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: s?.color ?? "#cbd5e1" }}
                        />
                        {s?.name ?? r.source}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-[11px] font-semibold">
                      {r.source === "ikyu" && !r.storeKey ? "店舗ID未設定（登録し直してください）" : storeLabelFor(stores, allSites, r.source, r.storeKey)}
                      <span className="ml-1 text-[10px] font-medium text-faint">{r.source === "ikyu" ? r.storeKey : r.storeKey || "既定"}</span>
                    </td>
                    <td className="px-5 py-2.5 text-[11px] font-medium text-subtle">{r.label || "—"}</td>
                    <td className="px-5 py-2.5 text-[11px] font-bold whitespace-nowrap text-ok" title="ID・パスワードは暗号化して保存され、画面には表示されません">
                      登録済み <span className="text-[9px] font-semibold text-faint">v{r.credentialsVersion}</span>
                    </td>
                    <td className="px-5 py-2.5 text-[11px] font-semibold whitespace-nowrap text-faint">
                      {new Date(r.updatedAt).toLocaleString("ja-JP", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        onClick={() => onDelete(r.id)}
                        className="rounded px-2 py-1 text-[10px] font-bold text-danger transition hover:bg-danger-soft"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="cell-wrap px-5 py-6 text-center text-[12px] font-semibold text-faint">
                    {scopeKeys ? "この店舗に登録されたアカウントはありません" : "登録されたアカウントはありません"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <form onSubmit={onSubmit} className="h-fit rounded-md border border-line bg-card">
        <header className="border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-bold tracking-tight">アカウントを追加</h2>
        </header>
        <div className="flex flex-col gap-3.5 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-subtle">サイト</span>
            <select
              value={source}
              onChange={(e) => { setSource(e.target.value); setPick(emptyPick(pick.storeId)); setShowPassword(false); }}
              className="rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold focus:border-brand focus:outline-none"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {source === "tabelog" ? (
            <p className="rounded bg-brand-soft px-3 py-2 text-[11px] leading-relaxed text-brand">
              食べログの店舗管理画面にログインする専用ID・パスワードを登録してください。
              一般会員用のメールアドレスや価格.com IDとは異なります。複数店舗は店舗コード（食べログの店舗ID）ごとに登録してください。
            </p>
          ) : source === "ikyu" ? (
            <p className="rounded bg-brand-soft px-3 py-2 text-[11px] leading-relaxed text-brand">
              一休.comレストラン管理画面と同じ3項目です（1店舗=1ログイン、店舗IDは6桁）。店舗ごとに登録でき、同じ店舗IDで保存すると上書きします。
              データの取り込みはGrok Botが行い、この登録情報を専用APIで受け取って使用します（アプリからは取得しません）。
            </p>
          ) : <p className="rounded bg-surface px-3 py-2 text-[11px] leading-relaxed text-subtle">このサイトもGrok Botが取り込みます。店舗ごとに登録すると、Grok Botが専用APIで受け取って使用します（アプリからは取得しません）。</p>}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-subtle">ラベル（任意）</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例: ディナー用"
              className="rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold placeholder:text-faint placeholder:font-normal focus:border-brand focus:outline-none"
            />
          </label>
          {stores.length ? (
            <StorePicker stores={stores} source={source} sourceName={srcMap.get(source)?.name ?? source} value={pick} onChange={setPick} />
          ) : (
            <p className="rounded bg-warn-soft px-3 py-2 text-[11px] font-semibold text-warn">先に「店舗管理」で店舗を登録してください。</p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-subtle">{source === "ikyu" ? "オペレータID" : "ログインID"}</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              placeholder={source === "ikyu" ? "オペレータIDを入力" : undefined}
              className="rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold placeholder:text-faint placeholder:font-normal focus:border-brand focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-subtle">パスワード</span>
            <input
              type={source === "ikyu" && showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold focus:border-brand focus:outline-none"
            />
            {source === "ikyu" ? (
              <button type="button" onClick={() => setShowPassword((v) => !v)} className="self-end text-[11px] font-bold text-brand underline">
                {showPassword ? "パスワードを隠す" : "パスワードを表示"}
              </button>
            ) : null}
          </label>
          {notice ? (
            <p className="rounded bg-surface px-3 py-2 text-[11px] font-semibold text-subtle">{notice}</p>
          ) : null}
          <button
            type="submit"
            disabled={saving || !stores.length}
            className="rounded-md bg-brand px-3.5 py-2.5 text-[12px] font-bold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存する"}
          </button>
          <p className="text-[10px] leading-relaxed font-medium text-faint">
            ID・パスワードは暗号化してgourmetのSupabaseに保存し、この画面には再表示しません（変更は同じ店舗で上書き保存）。
            すべてのサイトとも、Grok Bot専用APIからのみ受け渡し、受け渡しのたびに記録します（アプリ・GitHubからサイトへはログインしません）。GitHubの公開ファイルや実行ログには保存しません。
          </p>
        </div>
      </form>
    </div>
  );
}
