import { useCallback, useEffect, useState } from "react";
import { deleteCredential, getCredentials, saveCredential } from "../api";
import type { CredentialRow, SourceMeta } from "../types";

function ikyuAccount(username: string) {
  const [storeId, operatorId, extra] = username.split("\u001e");
  if (extra !== undefined || !/^\d{6}$/.test(storeId ?? "") || !operatorId) return null;
  return { storeId, operatorId };
}

type Props = {
  sources: SourceMeta[];
  onChanged: () => void;
};

export default function CredentialsPanel({ sources, onChanged }: Props) {
  const [rows, setRows] = useState<CredentialRow[]>([]);
  const [source, setSource] = useState<string>(sources[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [storeId, setStoreId] = useState("");
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
      if (!source || !username || !password || (source === "ikyu" && !/^\d{6}$/.test(storeId))) {
        setNotice(source === "ikyu" ? "店舗ID（6桁）・オペレータID・パスワードを入力してください" : "サイト / ID / パスワード を入力してください");
        return;
      }
      setSaving(true);
      setNotice(null);
      try {
        await saveCredential({ source, label, username, password, ...(source === "ikyu" ? { storeId } : {}) });
        setLabel("");
        setStoreId("");
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
    [source, label, storeId, username, password, refresh, onChanged],
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
                {["サイト", "ラベル", "ログインID", "更新日時", ""].map((h) => (
                  <th key={h} className="px-5 py-2.5 text-[10px] font-bold tracking-wide text-faint uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = srcMap.get(r.source);
                const ikyu = r.source === "ikyu" ? ikyuAccount(r.username) : null;
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
                    <td className="px-5 py-2.5 text-[11px] font-medium text-subtle">{r.label || "—"}</td>
                    <td className="px-5 py-2.5 text-[11px] font-semibold">
                      {ikyu ? `店舗 ${ikyu.storeId} / ${ikyu.operatorId}` : r.username}
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
                  <td colSpan={5} className="px-5 py-6 text-center text-[12px] font-semibold text-faint">
                    登録されたアカウントはありません
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
              onChange={(e) => { setSource(e.target.value); setStoreId(""); setShowPassword(false); }}
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
              一般会員用のメールアドレスや価格.com IDとは異なります。
            </p>
          ) : source === "ikyu" ? (
            <p className="rounded bg-brand-soft px-3 py-2 text-[11px] leading-relaxed text-brand">
              一休.comレストラン管理画面と同じ3項目です。店舗IDは6桁の数字です。自動取得の接続はこれからです。
            </p>
          ) : <p className="rounded bg-surface px-3 py-2 text-[11px] leading-relaxed text-subtle">このサイトの自動取得は接続準備中です。現在、自動取得できるのは食べログです。</p>}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-subtle">ラベル（任意）</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例: 丸五 東京ドーム店"
              className="rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold placeholder:text-faint placeholder:font-normal focus:border-brand focus:outline-none"
            />
          </label>
          {source === "ikyu" ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-subtle">店舗ID</span>
              <input
                value={storeId}
                onChange={(e) => setStoreId(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="店舗ID（6桁数字）を入力"
                className="rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold placeholder:text-faint placeholder:font-normal focus:border-brand focus:outline-none"
              />
            </label>
          ) : null}
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
            disabled={saving}
            className="rounded-md bg-brand px-3.5 py-2.5 text-[12px] font-bold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存する"}
          </button>
          <p className="text-[10px] leading-relaxed font-medium text-faint">
            パスワードは暗号化してgourmetのSupabaseに保存します。同期時だけGitHub Actionsの取得用ブラウザへ渡し、店舗管理画面のログインに使用します。GitHubの公開ファイルや実行ログには保存しません。
          </p>
        </div>
      </form>
    </div>
  );
}
