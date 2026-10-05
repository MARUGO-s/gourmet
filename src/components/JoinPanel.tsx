import { useState } from "react";
import { getTeamMe, requestJoin } from "../api";
import type { TeamMe } from "../types";

// チームに参加していない人（未申請・申請中・停止）の画面。データは見えない。承認は持ち主・管理者が「メンバー管理」で行う
export default function JoinPanel({ team, email, onChanged }: { team: TeamMe; email: string | null; onChanged: (team: TeamMe) => void }) {
  const [name, setName] = useState(team.displayName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      const { team: next } = await requestJoin(name);
      onChanged(next);
      setMessage({ text: team.role === "pending" ? "お名前を更新しました" : "参加申請を送りました。管理者の承認をお待ちください", error: false });
    } catch (e) { setMessage({ text: e instanceof Error ? e.message : "参加申請を送れませんでした", error: true }); }
    finally { setBusy(false); }
  };
  const reload = async () => {
    setBusy(true); setMessage(null);
    try { onChanged((await getTeamMe()).team); }
    catch (e) { setMessage({ text: e instanceof Error ? e.message : "状態を確認できませんでした", error: true }); }
    finally { setBusy(false); }
  };
  const box = "rounded-md border border-line bg-card px-3 py-2 text-[12px] font-semibold focus:border-brand focus:outline-none";
  return (
    <section className="mx-auto flex w-full max-w-[560px] flex-col gap-4 rounded-md border border-line bg-card p-6">
      <h2 className="text-[15px] font-bold tracking-tight">{team.role === "suspended" ? "利用が停止されています" : team.role === "pending" ? "承認をお待ちください" : "参加申請"}</h2>
      {team.role === "suspended" ? (
        <p className="text-[12px] leading-relaxed text-subtle">このアカウント（{email}）は利用が停止されています。再開が必要な場合は、管理者へお問い合わせください。</p>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed text-subtle">
            {team.role === "pending"
              ? <>参加申請を送りました{team.requestedAt ? `（${new Date(team.requestedAt).toLocaleString("ja-JP")}）` : ""}。管理者が承認し、担当店舗を設定すると、担当店舗のデータが表示されます。</>
              : <>このアプリは、管理者が承認した人だけが使えます。お名前（店舗名・役職など）を入力して参加申請を送ってください。管理者が承認し、担当店舗を設定すると使えるようになります。</>}
          </p>
          <p className="text-[11px] text-faint">ログイン中: {email}</p>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-[11px] font-bold text-subtle">お名前（店舗名・役職など）
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required placeholder="例: 渋谷店 店長 山田" className={box} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button disabled={busy || !name.trim()} className="rounded-md bg-brand px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50">
                {busy ? "送信中…" : team.role === "pending" ? "お名前を更新" : "参加申請を送る"}
              </button>
              {team.role === "pending" ? <button type="button" onClick={() => void reload()} disabled={busy} className="rounded-md border border-line bg-card px-4 py-2 text-[12px] font-bold text-subtle disabled:opacity-50">承認されたか確認</button> : null}
            </div>
          </form>
        </>
      )}
      {message ? <p role="status" className={`rounded px-3 py-2 text-[11px] font-bold ${message.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{message.error ? "⚠" : "✓"} {message.text}</p> : null}
    </section>
  );
}
