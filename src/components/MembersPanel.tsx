import { useCallback, useEffect, useMemo, useState } from "react";
import { getTeamMembers, removeTeamMember, updateTeamMember } from "../api";
import type { TeamMember, TeamMemberUpdate } from "../types";

// メンバー管理（持ち主・管理者だけ）。参加申請の承認、役割（管理者＝全店舗・メンバー＝担当店舗だけ）、担当店舗、停止・再開・削除。
// 管理者は、管理者の行・管理者への昇格・自分自身を変えられない（持ち主だけ。サーバーでも確かめる）
type Tab = "pending" | "active" | "suspended";
const TABS: [Tab, string][] = [["pending", "申請中"], ["active", "利用中"], ["suspended", "停止中"]];
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

export default function MembersPanel() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [me, setMe] = useState<{ role: "owner" | "admin"; userId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await getTeamMembers();
      setMembers(r.members); setStores(r.stores); setMe(r.me);
      // 申請が無ければ利用中を開く
      setTab((t) => (t === "pending" && !r.members.some((m) => m.status === "pending") ? "active" : t));
    } catch (e) { setError(e instanceof Error ? e.message : "メンバーを読み込めませんでした"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const counts = useMemo(() => Object.fromEntries(TABS.map(([t]) => [t, members.filter((m) => m.status === t).length])) as Record<Tab, number>, [members]);
  const shown = members.filter((m) => m.status === tab);
  const replace = (m: TeamMember) => setMembers((rows) => rows.map((x) => (x.id === m.id ? m : x)));

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-md border border-line bg-card p-5">
        <h2 className="text-[13px] font-bold tracking-tight">メンバー管理</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-subtle">
          ログインして「参加申請」を送った人を承認し、役割と担当店舗を決めます。<b>管理者</b>は全店舗のデータと設定（ログイン情報・店舗管理・メンバー管理を含む）、
          <b>メンバー</b>は担当店舗のデータ・AI分析・取得依頼・自動取得・口コミ通知だけを扱えます。停止した人は何も見られなくなります。
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`rounded-md border px-3 py-1.5 text-[12px] font-bold ${tab === t ? "border-brand bg-brand-soft text-brand" : "border-line bg-card text-subtle hover:text-ink"}`}>
              {label}<span className="ml-1.5 rounded bg-surface px-1.5 text-[10px] text-faint">{counts[t]}</span>
            </button>
          ))}
          <button onClick={() => void load()} disabled={loading} className="ml-auto rounded-md border border-line bg-card px-3 py-1.5 text-[12px] font-bold text-subtle disabled:opacity-50">再読み込み</button>
        </div>
      </div>
      {error ? <p className="rounded-md bg-danger-soft px-4 py-2.5 text-[12px] font-bold text-danger">⚠ {error}</p> : null}
      {loading && !members.length ? <p className="rounded-md border border-line bg-card px-6 py-10 text-center text-[12px] font-semibold text-faint">読み込み中…</p>
        : shown.length ? shown.map((m) => <MemberCard key={m.id} member={m} stores={stores} me={me} onSaved={replace} onRemoved={() => setMembers((rows) => rows.filter((x) => x.id !== m.id))} />)
        : <p className="rounded-md border border-line bg-card px-6 py-10 text-center text-[12px] font-semibold text-faint">{tab === "pending" ? "新しい参加申請はありません" : tab === "active" ? "利用中のメンバーはいません" : "停止中のメンバーはいません"}</p>}
    </section>
  );
}

function MemberCard({ member, stores, me, onSaved, onRemoved }: {
  member: TeamMember; stores: { id: string; name: string }[]; me: { role: "owner" | "admin"; userId: string } | null;
  onSaved: (m: TeamMember) => void; onRemoved: () => void;
}) {
  const [role, setRole] = useState(member.role);
  const [picked, setPicked] = useState<string[]>(member.storeIds ?? []);
  const [editing, setEditing] = useState(member.status === "pending");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  // 管理者は、管理者の行・自分自身を変えられず、管理者へ昇格できない（持ち主だけ）
  const locked = me?.role !== "owner" && (member.role === "admin" || member.userId === me?.userId);
  const canPromote = me?.role === "owner";
  const storeNames = (ids: string[] | null) => (ids == null ? "全店舗" : ids.length ? stores.filter((s) => ids.includes(s.id)).map((s) => s.name).join("、") : "未設定");
  const dirty = role !== member.role || (role === "member" && [...picked].sort().join() !== [...(member.storeIds ?? [])].sort().join());

  const save = async (extra: TeamMemberUpdate = {}, done = "保存しました") => {
    setBusy(true); setMessage(null);
    try {
      const input: TeamMemberUpdate = { ...(role !== member.role ? { role } : {}), ...(role === "member" ? { storeIds: picked } : {}), ...extra };
      const { member: saved } = await updateTeamMember(member.id, input);
      onSaved(saved); setEditing(false);
      setMessage({ text: done, error: false });
    } catch (e) { setMessage({ text: e instanceof Error ? e.message : "保存できませんでした", error: true }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`${member.displayName || member.email} をメンバーから削除しますか？（もう一度使うには参加申請からやり直します）`)) return;
    setBusy(true); setMessage(null);
    try { await removeTeamMember(member.id); onRemoved(); }
    catch (e) { setMessage({ text: e instanceof Error ? e.message : "削除できませんでした", error: true }); setBusy(false); }
  };
  const toggle = (id: string) => setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const btn = "rounded-md border border-line bg-card px-3 py-1.5 text-[11px] font-bold text-subtle hover:text-ink disabled:opacity-50";

  return (
    <article className="rounded-md border border-line bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold">{member.displayName || "（名前なし）"}<span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-subtle">{member.roleLabel}</span></p>
          <p className="truncate text-[11px] text-subtle">{member.email}</p>
          <p className="mt-1 text-[10px] text-faint">申請 {fmt(member.requestedAt)}{member.approvedAt ? ` · 承認 ${fmt(member.approvedAt)}` : ""}</p>
          {member.status !== "pending" ? <p className="mt-1 text-[11px] text-subtle">担当店舗: <b>{storeNames(member.storeIds)}</b></p> : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {member.status === "active" && !editing && !locked ? <button onClick={() => setEditing(true)} disabled={busy} className={btn}>役割・担当店舗を変更</button> : null}
          {member.status === "active" && !locked ? <button onClick={() => void save({ status: "suspended" }, "停止しました")} disabled={busy} className={btn}>停止</button> : null}
          {member.status === "suspended" && !locked ? <button onClick={() => void save({ status: "active" }, "再開しました")} disabled={busy} className={btn}>再開</button> : null}
          {!locked ? <button onClick={() => void remove()} disabled={busy} className={`${btn} hover:text-danger`}>削除</button> : null}
        </div>
      </div>
      {locked ? <p className="mt-2 text-[10px] text-faint">管理者の変更・自分自身の変更は持ち主だけができます</p> : null}
      {editing && !locked ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          <fieldset className="flex flex-wrap items-center gap-3 text-[12px]">
            <legend className="mb-1 text-[11px] font-bold text-subtle">役割</legend>
            <label className="flex items-center gap-1.5"><input type="radio" checked={role === "member"} onChange={() => setRole("member")} />メンバー（担当店舗だけ）</label>
            <label className={`flex items-center gap-1.5 ${canPromote ? "" : "opacity-50"}`}><input type="radio" checked={role === "admin"} disabled={!canPromote} onChange={() => setRole("admin")} />管理者（全店舗・すべての設定）</label>
          </fieldset>
          {role === "member" ? (
            <fieldset>
              <legend className="mb-1 text-[11px] font-bold text-subtle">担当店舗（{picked.length}店舗）
                <button type="button" onClick={() => setPicked(stores.map((s) => s.id))} className="ml-3 font-bold text-brand">すべて選択</button>
                <button type="button" onClick={() => setPicked([])} className="ml-2 font-bold text-brand">選択を外す</button>
              </legend>
              <div className="grid max-h-[240px] grid-cols-1 gap-1 overflow-y-auto rounded border border-line p-2 sm:grid-cols-2 lg:grid-cols-3">
                {stores.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5 text-[12px]"><input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />{s.name}</label>
                ))}
              </div>
              {!picked.length ? <p className="mt-1 text-[11px] font-bold text-warn">担当店舗が未設定です。承認しても、何も表示されません</p> : null}
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {member.status === "pending"
              ? <button onClick={() => void save({ status: "active" }, "承認しました")} disabled={busy} className="rounded-md bg-brand px-4 py-1.5 text-[12px] font-bold text-white disabled:opacity-50">承認する</button>
              : <button onClick={() => void save()} disabled={busy || !dirty} className="rounded-md bg-brand px-4 py-1.5 text-[12px] font-bold text-white disabled:opacity-50">保存</button>}
            {member.status !== "pending" ? <button onClick={() => { setRole(member.role); setPicked(member.storeIds ?? []); setEditing(false); }} disabled={busy} className={btn}>やめる</button> : null}
          </div>
        </div>
      ) : null}
      {message ? <p role="status" className={`mt-2 rounded px-3 py-1.5 text-[11px] font-bold ${message.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{message.error ? "⚠" : "✓"} {message.text}</p> : null}
    </article>
  );
}
