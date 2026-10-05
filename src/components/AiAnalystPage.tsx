import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { askAi, createAiReport, deleteAiReport, downloadAnswerPdf, getAiReport, getAiReports, getAiStatus } from "../api";
import type { AiChatMessage, AiReport, AiReportSummary, AiStatus, Store } from "../types";
import { markdownToHtml, reportHtmlDocument } from "../../supabase/functions/_shared/markdown.js";
import { formatTime } from "../lib/agent-requests";
import MtalkShareDialog, { ShareHistory, ShareToast, useReportShares } from "./MtalkShare";

type Props = { userId: string; stores: Store[]; scope: string };
type Preset = "7" | "30" | "90" | "thisMonth" | "lastMonth" | "12m" | "custom";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "7", label: "直近7日" }, { id: "30", label: "直近30日" }, { id: "90", label: "直近90日" },
  { id: "thisMonth", label: "今月" }, { id: "lastMonth", label: "先月" }, { id: "12m", label: "直近12か月" }, { id: "custom", label: "期間を指定" },
];
const EXAMPLES = [
  "直近30日のPVの推移と、前の30日との違いを教えて",
  "食べログと一休で、PV・予約・評価を比較して",
  "未返信の口コミを一覧にして、返信文の案を作って",
  "評価の低い口コミに共通する不満点は？",
  "先月の予約件数は前月と比べてどうだった？",
  "全店舗で、PVが伸びている店舗・落ちている店舗は？",
  "PVを増やすために今月やるべきことを3つ提案して",
];
const TOOL_LABELS: Record<string, string> = {
  list_stores: "店舗の一覧", get_kpis: "KPI", get_pv_trend: "PVの推移", get_monthly_metrics: "月別の記録",
  get_review_stats: "口コミの統計", get_reviews: "口コミの抜粋", compare_stores: "全店舗の比較",
};
const DAY = 86_400_000;
const jstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
function presetRange(p: Preset): { from: string; to: string } {
  const today = jstToday(), yesterday = shift(today, -1);
  if (p === "thisMonth") return { from: `${today.slice(0, 7)}-01`, to: today.slice(8) === "01" ? today : yesterday };
  if (p === "lastMonth") { const end = shift(`${today.slice(0, 7)}-01`, -1); return { from: `${end.slice(0, 7)}-01`, to: end }; }
  if (p === "12m") { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 12); return { from: d.toISOString().slice(0, 10), to: yesterday }; }
  const days = Number(p) || 90;
  return { from: shift(yesterday, -(days - 1)), to: yesterday };
}
const chatKey = (userId: string) => `gourmet.aiChat.${userId}`;
const loadChat = (userId: string): AiChatMessage[] => {
  try { const v = JSON.parse(window.sessionStorage.getItem(chatKey(userId)) ?? "[]"); return Array.isArray(v) ? v.slice(-60) : []; } catch { return []; }
};
const saveChat = (userId: string, rows: AiChatMessage[]) => { try { window.sessionStorage.setItem(chatKey(userId), JSON.stringify(rows.slice(-60))); } catch { /* 保存できない環境 */ } };
const fileName = (title: string, ext: string) => `${title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "report"}.${ext}`;
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const selectClass = "rounded-md border border-line bg-card px-2.5 py-1.5 text-[12px] font-semibold text-ink focus:outline-none";
const btn = "rounded-md border border-line bg-card px-3 py-1.5 text-[11px] font-bold text-subtle transition hover:text-ink disabled:opacity-50";
const primary = "rounded-md bg-brand px-3.5 py-2 text-[12px] font-bold text-white transition hover:opacity-90 disabled:opacity-50";

function Markdown({ text, className = "" }: { text: string; className?: string }) {
  // markdownToHtml は全文字をエスケープしてから許可した記法だけをタグにする（生のHTMLは表示しない）
  const html = useMemo(() => markdownToHtml(text), [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// AI分析: 店舗・期間を選んで質問（チャット）と、分析レポートの作成・保存・印刷
export default function AiAnalystPage({ userId, stores, scope }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "report">("chat");
  const [storeId, setStoreId] = useState(scope === "all" || stores.some((s) => s.id === scope) ? scope : "all");
  const [preset, setPreset] = useState<Preset>("90");
  const [range, setRange] = useState(() => presetRange("90"));
  const storeName = storeId === "all" ? "全店舗" : stores.find((s) => s.id === storeId)?.name ?? "店舗";

  useEffect(() => {
    let alive = true;
    getAiStatus().then((s) => { if (alive) setStatus(s); }).catch((e) => { if (alive) setStatusError(e instanceof Error ? e.message : "AI分析の状態を確認できませんでした"); });
    return () => { alive = false; };
  }, []);
  const onPreset = (p: Preset) => { setPreset(p); if (p !== "custom") setRange(presetRange(p)); };

  const selectors = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-[11px] font-bold text-subtle">店舗
        <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={`${selectClass} max-w-[220px]`}>
          <option value="all">全店舗</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] font-bold text-subtle">期間
        <select value={preset} onChange={(e) => onPreset(e.target.value as Preset)} className={selectClass}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <input type="date" aria-label="開始日" value={range.from} max={range.to} onChange={(e) => { setPreset("custom"); setRange((r) => ({ ...r, from: e.target.value })); }} className={selectClass} />
      <span className="text-[11px] text-faint">〜</span>
      <input type="date" aria-label="終了日" value={range.to} min={range.from} max={jstToday()} onChange={(e) => { setPreset("custom"); setRange((r) => ({ ...r, to: e.target.value })); }} className={selectClass} />
    </div>
  );

  return (
    <section className="flex flex-col gap-4" aria-label="AI分析">
      <div className="no-print flex flex-wrap items-center gap-3 rounded-md border border-line bg-card px-5 py-3.5">
        <div className="flex overflow-hidden rounded border border-line text-[12px] font-bold">
          <button onClick={() => setTab("chat")} className={`px-3 py-1.5 ${tab === "chat" ? "bg-brand text-white" : "text-subtle"}`}>質問する</button>
          <button onClick={() => setTab("report")} className={`px-3 py-1.5 ${tab === "report" ? "bg-brand text-white" : "text-subtle"}`}>レポート作成</button>
        </div>
        <div className="ml-auto">{selectors}</div>
      </div>
      {statusError ? <p className="no-print rounded-md bg-danger-soft px-4 py-2.5 text-[11px] font-bold text-danger">⚠ {statusError}</p> : null}
      {status && !status.configured ? (
        <p className="no-print rounded-md bg-warn-soft px-4 py-2.5 text-[11px] font-bold text-warn">
          ⚠ AI分析は未設定です。管理者がサーバー（Supabaseの秘密情報）に OpenAI の APIキーを設定すると利用できます。
        </p>
      ) : null}
      {tab === "chat"
        ? <Chat userId={userId} storeId={storeId} storeName={storeName} range={range} disabled={status ? !status.configured : false} model={status?.model} />
        : <Reports storeId={storeId} storeName={storeName} range={range} disabled={status ? !status.configured : false} />}
    </section>
  );
}

function Chat({ userId, storeId, storeName, range, disabled, model }: { userId: string; storeId: string; storeName: string; range: { from: string; to: string }; disabled: boolean; model?: string }) {
  const [messages, setMessages] = useState<AiChatMessage[]>(() => loadChat(userId));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // 回答のPDF（作成中の回答の番号と、失敗の文）
  const [pdfBusy, setPdfBusy] = useState<number | null>(null);
  const [pdfError, setPdfError] = useState<{ index: number; text: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { saveChat(userId, messages); endRef.current?.scrollIntoView({ block: "nearest" }); }, [userId, messages]);

  const send = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const at = new Date().toISOString();
    const history = messages.filter((m) => !m.error).slice(-12).map((m) => ({ role: m.role, content: m.content }));
    setMessages((rows) => [...rows, { role: "user", content: q, at, storeName, period: range }]);
    setText("");
    setBusy(true);
    try {
      const r = await askAi({ question: q, storeId, from: range.from, to: range.to, history });
      setMessages((rows) => [...rows, { role: "assistant", content: r.answer, at: new Date().toISOString(), calls: r.calls, period: r.period, storeName }]);
    } catch (e) {
      setMessages((rows) => [...rows, { role: "assistant", content: e instanceof Error ? e.message : "回答を取得できませんでした", at: new Date().toISOString(), error: true }]);
    } finally {
      setBusy(false);
    }
  }, [busy, messages, range, storeId, storeName]);

  // 回答 i をPDFでダウンロードする（質問は直前の自分の発言）
  const savePdf = async (i: number) => {
    const m = messages[i];
    const q = [...messages.slice(0, i)].reverse().find((x) => x.role === "user");
    setPdfBusy(i); setPdfError(null);
    try {
      const blob = await downloadAnswerPdf({ question: q?.content ?? "", answer: m.content, storeName: m.storeName ?? q?.storeName, from: (m.period ?? q?.period)?.from,
        to: (m.period ?? q?.period)?.to, askedAt: q?.at, answeredAt: m.at, model });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const t = new Date(Date.parse(m.at) + 9 * 3600_000).toISOString();
      a.href = url; a.download = `AI分析_回答_${t.slice(0, 10).replace(/-/g, "")}-${t.slice(11, 16).replace(":", "")}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setPdfError({ index: i, text: e instanceof Error ? e.message : "PDFを作成できませんでした" }); }
    finally { setPdfBusy(null); }
  };

  return (
    <div className="rounded-md border border-line bg-card">
      <header className="no-print flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <h2 className="text-[13px] font-bold tracking-tight">AIに質問</h2>
        <span className="text-[11px] text-subtle">{storeName} · {range.from} 〜 {range.to}</span>
        {model ? <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{model}</span> : null}
        {messages.length ? <button onClick={() => setMessages([])} className={`${btn} ml-auto`}>会話を消去</button> : null}
      </header>
      <div className="flex max-h-[62vh] min-h-[240px] flex-col gap-3 overflow-y-auto px-5 py-4">
        {!messages.length ? (
          <div className="no-print">
            <p className="text-[12px] text-subtle">店舗・期間を選んで、PV・予約・口コミについて自由に質問できます。AIが必要なデータ（店舗・サイト・期間別の集計）を取得して回答します。会話はこのタブを閉じるまで保存されます。</p>
            <p className="mt-3 text-[11px] font-bold text-faint">質問の例</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {EXAMPLES.map((q) => <button key={q} disabled={disabled || busy} onClick={() => void send(q)} className="rounded-full border border-line bg-surface px-3 py-1 text-[11px] font-semibold text-subtle transition hover:border-brand hover:text-brand disabled:opacity-50">{q}</button>)}
            </div>
          </div>
        ) : messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[88%] rounded-lg px-4 py-2.5 text-[12px] leading-relaxed ${m.role === "user" ? "bg-brand text-white" : m.error ? "bg-danger-soft font-bold text-danger" : "border border-line bg-surface"}`}>
              {m.role === "user" ? <p className="whitespace-pre-wrap">{m.content}</p> : m.error ? <p>⚠ {m.content}</p> : <Markdown text={m.content} />}
              <div className={`mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] ${m.role === "user" ? "text-white/70" : "text-faint"}`}>
                <span>{formatTime(m.at)}</span>
                {m.role === "user" && m.period ? <span>· {m.storeName} {m.period.from}〜{m.period.to}</span> : null}
                {m.calls?.length ? <span>· 参照: {[...new Set(m.calls.map((c) => TOOL_LABELS[c.name] ?? c.name))].join("・")}</span> : null}
                {m.role === "assistant" && !m.error ? <button onClick={() => void navigator.clipboard?.writeText(m.content)} className="no-print font-bold underline">コピー</button> : null}
                {m.role === "assistant" && !m.error ? (
                  <button onClick={() => void savePdf(i)} disabled={pdfBusy !== null} className="no-print inline-flex items-center gap-1 rounded border border-line bg-card px-2 py-0.5 font-bold text-subtle hover:border-brand hover:text-brand disabled:opacity-50">
                    {pdfBusy === i ? "PDF作成中…" : "PDFをダウンロード"}
                  </button>
                ) : null}
              </div>
              {pdfError?.index === i ? <p className="no-print mt-1 text-[10px] font-bold text-danger">⚠ {pdfError.text}</p> : null}
            </div>
          </div>
        ))}
        {busy ? <p className="text-[11px] font-semibold text-faint">AIが分析中…（データの取得を含めて数十秒かかることがあります）</p> : null}
        <div ref={endRef} />
      </div>
      <form className="no-print flex items-end gap-2 border-t border-line px-5 py-3" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} disabled={disabled}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }}
          placeholder={disabled ? "AI分析は未設定です" : "例: 先月と比べてPVが落ちた理由は？（⌘/Ctrl+Enterで送信）"}
          className="min-h-[44px] flex-1 resize-y rounded-md border border-line px-3 py-2 text-[12px] focus:border-brand focus:outline-none" />
        <button type="submit" disabled={disabled || busy || !text.trim()} className={primary}>{busy ? "回答中…" : "送信"}</button>
      </form>
    </div>
  );
}

function Reports({ storeId, storeName, range, disabled }: { storeId: string; storeName: string; range: { from: string; to: string }; disabled: boolean }) {
  const [list, setList] = useState<AiReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<AiReport | null>(null);
  const [title, setTitle] = useState("");
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const shareLog = useReportShares(current?.id);
  const load = useCallback(async () => {
    setLoading(true);
    try { setList((await getAiReports()).reports); }
    catch (e) { setNotice({ text: e instanceof Error ? e.message : "レポートを読み込めませんでした", error: true }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy("create"); setNotice(null);
    try {
      const { report } = await createAiReport({ storeId, from: range.from, to: range.to, ...(title.trim() ? { title: title.trim() } : {}), ...(focus.trim() ? { focus: focus.trim() } : {}) });
      setCurrent(report); setTitle(""); setFocus("");
      setNotice({ text: "レポートを作成して保存しました", error: false });
      void load();
    } catch (e) { setNotice({ text: e instanceof Error ? e.message : "レポートを作成できませんでした", error: true }); }
    finally { setBusy(null); }
  };
  const open = async (id: string) => {
    setBusy(id); setNotice(null);
    try { setCurrent((await getAiReport(id)).report); }
    catch (e) { setNotice({ text: e instanceof Error ? e.message : "レポートを開けませんでした", error: true }); }
    finally { setBusy(null); }
  };
  const remove = async (r: AiReportSummary) => {
    if (!window.confirm(`レポート「${r.title}」を削除しますか？`)) return;
    setBusy(r.id);
    try { await deleteAiReport(r.id); if (current?.id === r.id) setCurrent(null); void load(); }
    catch (e) { setNotice({ text: e instanceof Error ? e.message : "削除できませんでした", error: true }); }
    finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="rounded-md border border-line bg-card p-5">
          <h2 className="text-[13px] font-bold tracking-tight">レポート作成</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-subtle">
            <b>{storeName}</b> の <b>{range.from} 〜 {range.to}</b> について、サマリー・KPIの推移・サイト別の比較・口コミの傾向・未返信の口コミ・改善提案をまとめます。数値の表は集計データから作成し、文章をAIが書きます（1〜2分かかることがあります）。
          </p>
          <label className="mt-3 block text-[11px] font-bold text-subtle">タイトル（任意）
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder={`${storeName} 分析レポート`} className="mt-1 w-full rounded-md border border-line px-2.5 py-1.5 text-[12px] font-normal" />
          </label>
          <label className="mt-2 block text-[11px] font-bold text-subtle">特に知りたいこと（任意）
            <input value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={500} placeholder="例: 一休の予約を増やす施策" className="mt-1 w-full rounded-md border border-line px-2.5 py-1.5 text-[12px] font-normal" />
          </label>
          <button onClick={() => void create()} disabled={disabled || !!busy} className={`${primary} mt-3`}>{busy === "create" ? "作成中…" : "レポートを作成"}</button>
          {notice ? <p className={`mt-3 rounded px-3 py-2 text-[11px] font-bold ${notice.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{notice.error ? "⚠" : "✓"} {notice.text}</p> : null}
        </section>
        <section className="rounded-md border border-line bg-card">
          <header className="flex items-center gap-2 border-b border-line px-5 py-3">
            <h2 className="text-[13px] font-bold tracking-tight">保存したレポート</h2>
            <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{list.length} 件</span>
          </header>
          {loading && !list.length ? <p className="px-5 py-8 text-center text-[12px] font-semibold text-faint">読み込み中…</p> : list.length ? (
            <ul className="max-h-[320px] divide-y divide-line overflow-y-auto">
              {list.map((r) => (
                <li key={r.id} className={`flex items-center gap-3 px-5 py-2.5 ${current?.id === r.id ? "bg-brand-soft" : ""}`}>
                  <button onClick={() => void open(r.id)} disabled={!!busy} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12px] font-bold">{r.title}</span>
                    <span className="block text-[10px] text-faint">{r.storeName} · {r.from}〜{r.to} · 作成 {formatTime(r.createdAt)}</span>
                  </button>
                  <button onClick={() => void remove(r)} disabled={!!busy} className="text-[10px] font-bold text-faint hover:text-danger">削除</button>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-8 text-center text-[12px] text-faint">保存したレポートはありません</p>}
        </section>
      </div>
      {current ? (
        <article className="ai-report rounded-md border border-line bg-card" aria-label="分析レポート">
          <header className="no-print flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <span className="text-[11px] text-faint">{current.storeName} · {current.from}〜{current.to} · {current.model}</span>
            <div className="ml-auto flex flex-wrap gap-1.5">
              <button onClick={() => setSharing(true)} className="rounded-md bg-brand px-3 py-1.5 text-[11px] font-bold text-white transition hover:opacity-90">M-talkに送る</button>
              <button onClick={() => window.print()} className={btn}>印刷・PDF</button>
              <button onClick={() => download(fileName(current.title, "md"), current.markdown, "text/markdown")} className={btn}>Markdown</button>
              <button onClick={() => download(fileName(current.title, "html"), reportHtmlDocument(current.title, current.markdown), "text/html")} className={btn}>HTML</button>
              <button onClick={() => setCurrent(null)} className={btn}>閉じる</button>
            </div>
          </header>
          <Markdown text={current.markdown} className="md-report px-8 py-6" />
          <ShareHistory shares={shareLog.shares} loading={shareLog.loading} />
        </article>
      ) : null}
      {current && sharing ? <MtalkShareDialog report={current} onClose={() => setSharing(false)} onSent={() => void shareLog.reload()} onToast={setToast} /> : null}
      <ShareToast toast={toast} onClose={closeToast} />
    </div>
  );
}
