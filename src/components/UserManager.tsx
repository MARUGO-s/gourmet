import { useCallback, useEffect, useState } from "react";
import { ApiError, deleteManagedUser, getManagedUsers, setUserAccess, setUserAdmin } from "../api";
import type { ManagedUser, ManagedUsers } from "../types";
import { GLOBAL_USERS_URL } from "../../supabase/functions/_shared/user-management-links.js";

const date = (value: string | null) => value ? new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "未ログイン";
const ACCESS_LABELS = { pending: "承認待ち・閲覧不可", approved: "閲覧可能", revoked: "閲覧停止" };
type Action = "admin" | "access" | "stop" | "delete";

export default function UserManager({ userId, onForbidden }: { userId: string; onForbidden: () => void }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ManagedUsers | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<ManagedUser | null>(null);
  const [action, setAction] = useState<Action>("admin");
  const [selectedStores, setSelectedStores] = useState<string[]>([]);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await getManagedUsers(page)); }
    catch (e) {
      setData(null);
      if (e instanceof ApiError && e.status === 403) onForbidden();
      setNotice({ error: true, text: e instanceof Error ? e.message : "ユーザーを読み込めませんでした" });
    } finally { setLoading(false); }
  }, [page, onForbidden]);
  useEffect(() => { void load(); }, [load]);

  function choose(u: ManagedUser, next: Action) {
    setTarget(u); setAction(next); setSelectedStores(u.storeIds); setConfirmEmail(""); setNotice(null);
  }

  async function changeRole() {
    if (!target || busy) return;
    const selected = target;
    setBusy(true); setNotice(null);
    try {
      if (action === "admin") await setUserAdmin(selected.id, !selected.isAdmin);
      else if (action === "delete") await deleteManagedUser(selected.id, confirmEmail);
      else await setUserAccess(selected.id, action === "stop" ? "revoked" : "approved", action === "stop" ? [] : selectedStores);
      setTarget(null);
      setNotice({ error: false, text: `${selected.email}：${action === "admin" ? `管理者権限を${selected.isAdmin ? "解除" : "設定"}しました` : action === "delete" ? "ユーザーを削除しました" : action === "stop" ? "閲覧を停止しました" : "承認し、閲覧店舗を保存しました"}` });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) onForbidden();
      setNotice({ error: true, text: e instanceof Error ? e.message : "権限を変更できませんでした" });
    } finally { setBusy(false); }
  }

  return <section className="rounded-md border border-line bg-card">
    <header className="flex flex-wrap items-center gap-3 border-b border-line p-5">
      <h2 className="text-[14px] font-bold">ユーザー管理</h2>
      <span className="rounded bg-brand-soft px-2 py-1 text-[11px] font-bold text-brand">管理者専用</span>
      <a href={GLOBAL_USERS_URL} target="_blank" rel="noopener noreferrer" className="rounded border border-line px-3 py-1.5 text-[12px] font-bold text-brand">全アプリのユーザー管理 ↗</a>
      <span className="ml-auto text-[12px] text-subtle">登録ユーザー {data?.total ?? "—"}人</span>
      <button disabled={loading || busy} onClick={() => { setNotice(null); void load(); }} className="rounded border border-line px-3 py-1.5 text-[12px] font-bold disabled:opacity-50">更新</button>
      <p className="w-full text-[12px] leading-relaxed text-subtle">新規登録は承認待ち・閲覧不可です。「承認・店舗設定」で閲覧する店舗を選んで承認してください。一般ユーザーは指定店舗の閲覧のみ、管理者は全店舗の閲覧と各種操作ができます。自分自身や最後の管理者は解除できません。</p>
      <p className="w-full text-[11px] text-subtle">全体管理ページにも同じ管理者・承認状態・閲覧店舗が反映されます（再読込で更新）。全体管理ページには別途、全アプリ管理者のGoogleログインが必要です。</p>
    </header>
    {notice && <p role={notice.error ? "alert" : "status"} className={`m-4 rounded p-3 text-[12px] ${notice.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{notice.text}</p>}
    {target && <div role="region" aria-label="権限変更の確認" className="m-4 rounded border border-line bg-surface p-4 text-[12px]">
      <p className="break-all font-bold">{target.email}：{action === "admin" ? target.isAdmin ? "管理者権限を解除しますか？" : "管理者に任命しますか？" : action === "delete" ? "ユーザーを完全に削除しますか？" : action === "stop" ? "閲覧を停止しますか？" : "承認・閲覧店舗の設定"}</p>
      {action === "admin" && <p className="mt-2 text-subtle">{target.isAdmin ? "一般ユーザーに戻ります。閲覧店舗が未設定の場合は、承認・店舗設定も必要です。" : "全店舗の閲覧と各種設定、ユーザーの承認・管理者任命・削除ができるようになります。"}</p>}
      {action === "access" && <fieldset disabled={busy} className="mt-3"><legend className="font-bold">閲覧を許可する店舗（1店舗以上）</legend><div className="mt-2 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">{data?.stores.map(s => <label key={s.id} className="flex items-center gap-2 rounded border border-line bg-card p-2"><input type="checkbox" checked={selectedStores.includes(s.id)} onChange={e => setSelectedStores(ids => e.target.checked ? [...ids, s.id] : ids.filter(id => id !== s.id))} />{s.name}</label>)}</div></fieldset>}
      {action === "stop" && <p className="mt-2 text-subtle">このユーザーは店舗データを閲覧できなくなります。再び利用させるときは、店舗を指定して承認してください。</p>}
      {action === "delete" && <><p className="mt-2 text-danger">この操作は元に戻せません。共通ログインアカウントを削除するため、同じアカウントを使うSNSなどにもログインできなくなります。管理者・データ所有者は削除できません。</p><label className="mt-3 block">確認のため対象のメールアドレスを入力<input value={confirmEmail} onChange={e => setConfirmEmail(e.target.value)} disabled={busy} autoComplete="off" className="mt-1 w-full rounded border border-line bg-card p-2" /></label></>}
      <div className="mt-3 flex gap-2"><button disabled={busy || (action === "access" && selectedStores.length === 0) || (action === "delete" && confirmEmail !== target.email)} onClick={() => void changeRole()} className={`rounded px-3 py-2 font-bold text-white disabled:opacity-50 ${action === "delete" ? "bg-danger" : "bg-brand"}`}>{busy ? "処理中…" : action === "access" ? "承認して保存" : action === "delete" ? "完全に削除する" : "確定する"}</button><button disabled={busy} onClick={() => setTarget(null)} className="rounded border border-line px-3 py-2 disabled:opacity-50">キャンセル</button></div>
    </div>}
    {loading ? <p className="p-6 text-center text-[12px] text-faint">読み込み中…</p> : data && <>
      <div className="overflow-x-auto"><table className="w-full text-left text-[12px]">
        <thead className="bg-surface text-subtle"><tr>{["ユーザー", "役割・閲覧状態", "閲覧店舗", "最終ログイン（日本時間）", "操作"].map(t => <th key={t} className="whitespace-nowrap px-4 py-3">{t}</th>)}</tr></thead>
        <tbody>{data.users.map(u => <tr key={u.id} className="border-t border-line">
          <td className="px-4 py-4"><p className="break-all font-bold">{u.email || "メールアドレス未登録"}{u.id === userId ? "（自分）" : ""}</p><p className="mt-1 text-[11px] text-faint">{u.confirmed ? "メール確認済み" : "メール未確認"} · 登録 {date(u.createdAt)}</p></td>
          <td className="whitespace-nowrap px-4 py-4"><span className={`rounded px-2 py-1 font-bold ${u.isAdmin ? "bg-brand-soft text-brand" : "bg-surface text-subtle"}`}>{u.isAdmin ? "管理者" : "一般ユーザー"}</span><p className={`mt-2 text-[11px] ${u.accessStatus === "approved" ? "text-ok" : "text-warn"}`}>{ACCESS_LABELS[u.accessStatus]}</p></td>
          <td className="min-w-36 px-4 py-4">{u.isAdmin ? "全店舗" : u.storeIds.length ? u.storeIds.map(id => data.stores.find(s => s.id === id)?.name ?? "削除された店舗").join(" / ") : "未設定"}</td><td className="whitespace-nowrap px-4 py-4">{date(u.lastSignInAt)}</td>
          <td className="px-4 py-4"><div className="flex min-w-44 flex-wrap gap-2">
            {!u.isAdmin && <button disabled={busy} onClick={() => choose(u, "access")} className="rounded border border-line px-3 py-2 font-bold text-brand disabled:opacity-40">承認・店舗設定</button>}
            {!u.isAdmin && u.accessStatus === "approved" && <button disabled={busy} onClick={() => choose(u, "stop")} className="rounded border border-line px-3 py-2 disabled:opacity-40">閲覧停止</button>}
            <button disabled={busy || u.id === userId} onClick={() => choose(u, "admin")} className="rounded border border-line px-3 py-2 font-bold text-brand disabled:opacity-40">{u.isAdmin ? "管理者を解除" : "管理者に任命"}</button>
            <button disabled={busy || !u.deletable || u.id === userId} onClick={() => choose(u, "delete")} title={!u.deletable ? "管理者・店舗データ所有者は削除できません" : "ユーザーを完全に削除"} className="rounded border border-line px-3 py-2 font-bold text-danger disabled:opacity-40">削除</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {!data.users.length && <p className="p-5 text-[12px] text-subtle">このページにユーザーはいません。</p>}
      <div className="flex items-center justify-end gap-3 border-t border-line p-4 text-[12px]"><button disabled={page <= 1 || busy} onClick={() => { setTarget(null); setPage(p => p - 1); }} className="rounded border border-line px-3 py-1 disabled:opacity-40">前へ</button><span>{page} / {Math.max(1, Math.ceil(data.total / 100))}ページ</span><button disabled={page * 100 >= data.total || busy} onClick={() => { setTarget(null); setPage(p => p + 1); }} className="rounded border border-line px-3 py-1 disabled:opacity-40">次へ</button></div>
    </>}
  </section>;
}
