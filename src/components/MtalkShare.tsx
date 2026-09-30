import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAiReportShares, getMtalkRecipients, shareAiReportToMtalk } from "../api";
import type { AiReport, AiReportShare, MtalkRecipient } from "../types";
import { buildShareCard, senderLabel, shareFileName, type ShareCardData } from "../../supabase/functions/_shared/mtalk-share.js";
import { supabase } from "../lib/supabase";
import { formatTime } from "../lib/agent-requests";

// AI分析レポートを M-talk の利用者1人へ送る（「AI分析」Botのカード＋PDF）。
// 送信先の一覧・送信・履歴はすべて ai-analyst 経由（M-talk の接続情報はブラウザに渡さない）。

type Toast = { text: string; error: boolean } | null;
const btn = "rounded-md border border-line bg-card px-3 py-1.5 text-[11px] font-bold text-subtle transition hover:text-ink disabled:opacity-50";
const primary = "rounded-md bg-brand px-3.5 py-2 text-[12px] font-bold text-white transition hover:opacity-90 disabled:opacity-50";
const STATUS: Record<AiReportShare["status"], { label: string; cls: string }> = {
  sent: { label: "送信済み", cls: "bg-ok-soft text-ok" },
  failed: { label: "失敗", cls: "bg-danger-soft text-danger" },
  pending: { label: "送信中", cls: "bg-warn-soft text-warn" },
};

export function ShareToast({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(onClose, toast.error ? 8000 : 5000);
    return () => window.clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div role={toast.error ? "alert" : "status"} className={`no-print fixed bottom-5 right-5 z-50 flex max-w-[min(92vw,420px)] items-start gap-2 rounded-md px-4 py-3 text-[12px] font-bold shadow-lg ${toast.error ? "bg-danger text-white" : "bg-ok text-white"}`}>
      <span>{toast.error ? "⚠" : "✓"}</span><span className="flex-1 leading-relaxed">{toast.text}</span>
      <button onClick={onClose} aria-label="閉じる" className="opacity-80 hover:opacity-100">×</button>
    </div>
  );
}

/** M-talk の Bot カードと同じ見た目のプレビュー（line_report public/chat/attachments.js の renderCard に合わせる） */
export function MtalkCardPreview({ data, fileName }: { data: ShareCardData; fileName: string }) {
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <dl className="m-0 flex gap-2.5 text-[13px] leading-snug"><dt className="w-[76px] shrink-0 whitespace-nowrap text-[#6b7280]">{label}</dt><dd className="m-0 min-w-0 flex-1 break-words text-[#111827]">{children}</dd></dl>
  );
  return (
    <div className="flex flex-col gap-1.5" aria-label="M-talkでの表示（プレビュー）">
      <div className="flex items-center gap-2 text-[11px] font-bold text-subtle">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-[#1f2d3d] text-[10px] text-white">AI</span>AI分析
      </div>
      <div className="max-w-[360px] overflow-hidden rounded-[14px] bg-white text-[#111] shadow-[0_1px_3px_rgba(0,0,0,0.18)]">
        <div className="bg-[#1f2d3d] px-3.5 py-3 text-white">
          <div className="text-[12px] text-white/70">AI分析レポート</div>
          <div className="mt-0.5 break-words text-[16px] font-bold leading-snug">{data.title}</div>
          {data.card.subtitle ? <div className="mt-1 break-words text-[12px] text-white/80">{data.card.subtitle}</div> : null}
        </div>
        <div className="flex flex-col gap-1 px-3.5 py-3">
          <Row label="送信者"><b>{data.sender_label}</b></Row>
          {data.card.fields.map((f) => <Row key={f.label} label={f.label}>{f.value}</Row>)}
          {data.card.highlights.length ? <><hr className="my-2 border-0 border-t border-[#eceff3]" /><Row label="要点">{data.card.highlights.map((h, i) => <div key={i} className={i ? "mt-0.5" : ""}>・{h}</div>)}</Row></> : null}
          {data.card.recommendations.length ? <><hr className="my-2 border-0 border-t border-[#eceff3]" /><Row label="施策">{data.card.recommendations.map((h, i) => <div key={i} className={i ? "mt-0.5" : ""}>{i + 1}. {h}</div>)}</Row></> : null}
          <hr className="my-2 border-0 border-t border-[#eceff3]" />
          <div className="text-center text-[12px] text-[#8a94a6]">レポート全文はこのあとのPDF（{fileName}）をご覧ください。</div>
        </div>
      </div>
      <div className="flex max-w-[360px] items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-[12px]">
        <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-bold text-danger">PDF</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{fileName}</span>
      </div>
    </div>
  );
}

export function ShareHistory({ shares, loading }: { shares: AiReportShare[]; loading: boolean }) {
  return (
    <section className="no-print border-t border-line px-5 py-3" aria-label="M-talkへの送信履歴">
      <h3 className="text-[12px] font-bold text-subtle">M-talkへの送信履歴</h3>
      {loading && !shares.length ? <p className="mt-2 text-[11px] text-faint">読み込み中…</p> : shares.length ? (
        <ul className="mt-2 divide-y divide-line">
          {shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[11px]">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
              <span className="font-bold">{s.recipientName}</span>
              <span className="text-faint">{formatTime(s.sentAt ?? s.createdAt)}</span>
              {s.status === "failed" && s.error ? <span className="basis-full text-danger">{s.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-[11px] text-faint">まだ送信していません</p>}
    </section>
  );
}

export function useReportShares(reportId: string | undefined) {
  const [shares, setShares] = useState<AiReportShare[]>([]);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!reportId) { setShares([]); return; }
    setLoading(true);
    try { setShares((await getAiReportShares(reportId)).shares); } catch { /* 履歴が読めなくても送信はできる */ } finally { setLoading(false); }
  }, [reportId]);
  useEffect(() => { void reload(); }, [reload]);
  return { shares, loading, reload };
}

export default function MtalkShareDialog({ report, onClose, onSent, onToast }: {
  report: AiReport; onClose: () => void; onSent: () => void; onToast: (t: Toast) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [recipients, setRecipients] = useState<MtalkRecipient[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MtalkRecipient | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sender, setSender] = useState("");

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setSender(senderLabel(data.session?.user)); });
    getMtalkRecipients().then((r) => { if (alive) setRecipients(r.recipients); })
      .catch((e) => { if (alive) setLoadError(e instanceof Error ? e.message : "送信先を読み込めませんでした"); });
    return () => { alive = false; };
  }, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = recipients ?? [];
    return (q ? list.filter((r) => r.username.toLowerCase().includes(q) || r.stores.some((s) => s.toLowerCase().includes(q))) : list).slice(0, 200);
  }, [recipients, query]);
  const card = useMemo(() => buildShareCard(report, { sender: sender || "（あなたのアカウント名）" }), [report, sender]);
  const fileName = useMemo(() => shareFileName(report), [report]);
  const close = () => { if (!busy) { dialog.current?.close(); onClose(); } };

  const send = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await shareAiReportToMtalk(report.id, selected.id);
      onToast({ text: `${selected.username}さんにM-talkで送信しました`, error: false });
      onSent();
      dialog.current?.close(); onClose();
    } catch (e) {
      onToast({ text: e instanceof Error ? e.message : "M-talkへ送信できませんでした", error: true });
      setConfirming(false);
      onSent();
    } finally { setBusy(false); }
  };

  return (
    <dialog ref={dialog} onCancel={(e) => { e.preventDefault(); close(); }} aria-labelledby="mtalk-share-title"
      className="m-auto w-[min(96vw,860px)] rounded-lg border border-line bg-card p-0 text-ink backdrop:bg-black/40">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <h2 id="mtalk-share-title" className="text-[14px] font-bold">M-talkに送る</h2>
        <span className="truncate text-[11px] text-faint">{report.title}</span>
        <button type="button" aria-label="閉じる" onClick={close} className="ml-auto text-[16px] text-subtle">×</button>
      </div>
      <div className="grid gap-5 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="mtalk-recipient-search" className="text-[11px] font-bold text-subtle">送信先（M-talkの利用者を1人選ぶ）</label>
          <input id="mtalk-recipient-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前・店舗で検索" autoComplete="off"
            role="combobox" aria-expanded="true" aria-controls="mtalk-recipient-list" disabled={!recipients}
            className="rounded-md border border-line px-2.5 py-1.5 text-[12px] focus:border-brand focus:outline-none" />
          {loadError ? <p className="rounded bg-danger-soft px-3 py-2 text-[11px] font-bold text-danger">⚠ {loadError}</p> : !recipients ? <p className="px-1 py-6 text-center text-[11px] text-faint">送信先を読み込み中…</p> : (
            <ul id="mtalk-recipient-list" role="listbox" aria-label="送信先" className="max-h-[300px] overflow-y-auto rounded-md border border-line">
              {filtered.length ? filtered.map((r) => (
                <li key={r.id} role="option" aria-selected={selected?.id === r.id}>
                  <button type="button" onClick={() => { setSelected(r); setConfirming(false); }}
                    className={`flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left last:border-b-0 ${selected?.id === r.id ? "bg-brand-soft" : "hover:bg-surface"}`}>
                    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selected?.id === r.id ? "border-brand bg-brand text-[9px] text-white" : "border-line"}`}>{selected?.id === r.id ? "✓" : ""}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-bold">{r.username}</span>
                      {r.stores.length ? <span className="block truncate text-[10px] text-faint">{r.stores.join("・")}</span> : null}
                    </span>
                  </button>
                </li>
              )) : <li className="px-3 py-6 text-center text-[11px] text-faint">該当する利用者がいません</li>}
            </ul>
          )}
          {recipients ? <p className="text-[10px] text-faint">{recipients.length}人（利用停止中の人とBotは表示されません）</p> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-[11px] font-bold text-subtle">M-talkでの表示（プレビュー）</span>
          <div className="rounded-md bg-[#8cabd9]/25 p-3"><MtalkCardPreview data={card} fileName={fileName} /></div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        {confirming && selected ? (
          <>
            <p className="flex-1 text-[12px] font-bold">{selected.username}さんに「AI分析」からこのレポート（カード＋PDF）を送信します。よろしいですか？</p>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={btn}>戻る</button>
            <button type="button" onClick={() => void send()} disabled={busy} className={primary}>{busy ? "送信中…" : "送信する"}</button>
          </>
        ) : (
          <>
            <p className="flex-1 text-[11px] text-subtle">{selected ? <>送信先: <b className="text-ink">{selected.username}</b></> : "送信先を選んでください"}</p>
            <button type="button" onClick={close} className={btn}>キャンセル</button>
            <button type="button" onClick={() => setConfirming(true)} disabled={!selected || busy} className={primary}>送信内容を確認</button>
          </>
        )}
      </div>
    </dialog>
  );
}
