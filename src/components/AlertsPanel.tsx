import { useCallback, useEffect, useState } from "react";
import { getAlertLog, getAlertSettings, saveAlertSetting } from "../api";
import type { AlertDelivery, AlertEvent, AlertSetting, SourceMeta, StoreBot } from "../types";
import { ALERT_LIMITS, ALERT_STATUS_LABELS, matchStoreBot } from "../../supabase/functions/_shared/review-alerts.js";

type Props = { sources: SourceMeta[] };
// bot: "auto"（店舗名で判定）/ "none"（送らない）/ Bot の id（指定）。rooms: null = Bot が参加している全グループ
type Draft = { newReviews: boolean; scoreChanges: boolean; bot: string; rooms: number[] | null };
const draftOf = (s: AlertSetting): Draft => ({ newReviews: s.newReviews, scoreChanges: s.scoreChanges, bot: s.botMode === "manual" && s.botId ? s.botId : s.botMode, rooms: s.roomIds });
const sameDraft = (a: Draft, b: Draft) => a.newReviews === b.newReviews && a.scoreChanges === b.scoreChanges && a.bot === b.bot
  && (a.rooms ?? []).slice().sort().join() === (b.rooms ?? []).slice().sort().join();
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const inputClass = "rounded border border-line bg-card px-2 py-1 text-[11px] font-semibold focus:border-brand focus:outline-none";

// 口コミ通知: 取り込みで新しい口コミが入ったとき・食べログの総合点が変わったときに、その店舗の M-talk 店舗Botとして
// Bot が参加しているグループのルームへ送る。店舗ごとの設定と履歴
export default function AlertsPanel({ sources }: Props) {
  const [settings, setSettings] = useState<AlertSetting[]>([]);
  const [bots, setBots] = useState<StoreBot[] | null>(null);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [log, setLog] = useState<{ deliveries: AlertDelivery[]; events: AlertEvent[] }>({ deliveries: [], events: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const siteName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([getAlertSettings(), getAlertLog()]);
      setSettings(s.settings);
      setBots(s.bots);
      setBotsError(s.botsError);
      setLog(l);
      setDrafts({});
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "読み込めませんでした", error: true });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const setDraft = (s: AlertSetting, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [s.storeId]: { ...(d[s.storeId] ?? draftOf(s)), ...patch } }));
  // 下書きで送る Bot（自動は店舗名で判定。Bot 一覧が読めないときは保存済みの判定結果）
  const botOf = (s: AlertSetting, draft: Draft): { id: string; name: string; auto: boolean } | null => {
    if (draft.bot === "none") return null;
    if (draft.bot === "auto") {
      if (!bots) return s.botMode === "auto" && s.bot ? { id: s.bot.id, name: s.bot.name, auto: true } : null;
      const m = matchStoreBot(s.storeName, bots);
      return m ? { id: m.bot.id, name: m.bot.username, auto: true } : null;
    }
    const b = bots?.find((x) => x.id === draft.bot);
    return { id: draft.bot, name: b?.username ?? s.botName ?? s.bot?.name ?? "店舗Bot", auto: false };
  };

  const save = async (s: AlertSetting) => {
    const draft = drafts[s.storeId] ?? draftOf(s);
    const bot = botOf(s, draft);
    // ルームを選んだら、そのとき判定された Bot を指定として保存する（名前が変わっても同じルームへ）
    const input = draft.bot === "none" ? { mode: "none" as const }
      : draft.bot === "auto" && !draft.rooms ? { mode: "auto" as const }
      : bot ? { mode: "manual" as const, id: bot.id, name: bot.name } : null;
    if (!input) { setNotice({ text: "店舗Botを選んでください", error: true }); return; }
    setBusy(s.storeId);
    setNotice(null);
    try {
      const { setting } = await saveAlertSetting({ storeId: s.storeId, newReviews: draft.newReviews, scoreChanges: draft.scoreChanges, bot: input, roomIds: input.mode === "manual" ? draft.rooms : null });
      setSettings((list) => list.map((x) => (x.storeId === s.storeId ? setting : x)));
      setDrafts((d) => { const n = { ...d }; delete n[s.storeId]; return n; });
      setNotice({ text: `${s.storeName}の通知設定を保存しました`, error: false });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "保存できませんでした", error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-md border border-line bg-card">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-bold tracking-tight">口コミ通知</h2>
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{settings.length} 店舗</span>
          <button onClick={() => void refresh()} className="ml-auto rounded border border-line px-2 py-1 text-[11px] font-bold text-subtle">{loading ? "更新中…" : "更新"}</button>
        </header>
        <div className="px-5 pt-4 text-[12px] leading-relaxed text-subtle">
          <p>取り込み（自動取得・取得依頼のどちらでも）で<b>新しい口コミ</b>が入ったとき、または<b>食べログの総合点</b>が前回から変わったときに、その店舗の<b>M-talk 店舗Bot</b>として、Botが参加しているグループのルームへ送ります（1対1は除く）。1通に口コミ{ALERT_LIMITS.reviewsPerMessage}件まで（残りは「ほか N件」）。同じ口コミ・同じ変化は同じルームへ二度送りません。</p>
          <p className="mt-2 rounded bg-surface px-3 py-2 text-[11px] font-semibold text-faint">店舗Botは店舗名から自動で選びます（違う場合は選び直してください）。店舗Botが「未設定」の店舗には送りません。通知を始める前から取り込まれていた口コミと、投稿から60日より前の口コミは送りません。</p>
        </div>
        {notice ? (
          <p className={`mx-5 mt-3 rounded px-3 py-2 text-[11px] font-bold ${notice.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{notice.error ? "⚠" : "✓"} {notice.text}</p>
        ) : null}
        {botsError ? <p className="mx-5 mt-3 rounded bg-warn-soft px-3 py-2 text-[11px] font-semibold text-warn">⚠ {botsError}（保存済みの設定はそのまま使われます）</p> : null}
        <ul className="mt-3 divide-y divide-line">
          {settings.map((s) => {
            const draft = drafts[s.storeId] ?? draftOf(s);
            const dirty = !sameDraft(draft, draftOf(s));
            const bot = botOf(s, draft);
            const rooms = bot ? bots?.find((b) => b.id === bot.id)?.rooms ?? [] : [];
            const toggleRoom = (id: number, on: boolean) => {
              const cur = draft.rooms ?? rooms.map((r) => r.id);
              const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
              setDraft(s, { rooms: next.length === rooms.length ? null : next.length ? next : draft.rooms });
            };
            return (
              <li key={s.storeId} className="flex flex-col gap-2 px-5 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[12px] font-bold">{s.storeName}</span>
                  {bot ? null : <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-bold text-warn">未設定</span>}
                  <label className="inline-flex items-center gap-1 text-[11px] font-semibold">
                    <input type="checkbox" checked={draft.newReviews} onChange={(e) => setDraft(s, { newReviews: e.target.checked })} />新着口コミ
                  </label>
                  <label className="inline-flex items-center gap-1 text-[11px] font-semibold">
                    <input type="checkbox" checked={draft.scoreChanges} onChange={(e) => setDraft(s, { scoreChanges: e.target.checked })} />食べログ総合点の変化
                  </label>
                  <button disabled={!dirty || busy === s.storeId} onClick={() => void save(s)}
                    className="ml-auto rounded bg-brand px-3 py-1 text-[11px] font-bold text-white disabled:opacity-40">{busy === s.storeId ? "保存中…" : "保存"}</button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-faint">店舗Bot:</span>
                  <select aria-label="店舗Bot" value={draft.bot} onChange={(e) => setDraft(s, { bot: e.target.value, rooms: null })} className={inputClass}>
                    <option value="auto">自動（店舗名で判定{draft.bot === "auto" ? `: ${bot?.name ?? "見つかりません"}` : ""}）</option>
                    {(bots ?? []).map((b) => <option key={b.id} value={b.id}>{b.username}</option>)}
                    {draft.bot !== "auto" && draft.bot !== "none" && !bots?.some((b) => b.id === draft.bot) ? <option value={draft.bot}>{bot?.name ?? "保存済みのBot"}</option> : null}
                    <option value="none">送らない（未設定）</option>
                  </select>
                </div>
                {bot && rooms.length ? (
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-faint">ルーム:</span>
                    {rooms.map((r) => (
                      <label key={r.id} className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 font-semibold">
                        <input type="checkbox" checked={!draft.rooms || draft.rooms.includes(r.id)} onChange={(e) => toggleRoom(r.id, e.target.checked)} />
                        {r.name}{r.isStoreRoom ? <span className="text-faint">（店舗ルーム）</span> : null}{r.members != null ? <span className="text-faint">{r.members}人</span> : null}
                      </label>
                    ))}
                    <span className="text-faint">{draft.rooms ? `${draft.rooms.length}件を選択` : "すべてのグループ（既定）"}</span>
                  </div>
                ) : bot && bots ? <p className="text-[11px] font-semibold text-warn">このBotが参加しているグループのルームがありません（送れません）</p> : null}
              </li>
            );
          })}
          {!settings.length && !loading ? <li className="px-5 py-6 text-center text-[12px] font-semibold text-faint">店舗がありません。「店舗管理」から店舗を追加してください</li> : null}
        </ul>
      </section>

      <section className="rounded-md border border-line bg-card">
        <header className="border-b border-line px-5 py-3.5"><h2 className="text-[13px] font-bold tracking-tight">通知の履歴</h2></header>
        <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[11px] font-bold text-faint">送信</h3>
            <ul className="flex flex-col gap-1.5 text-[11px]">
              {log.deliveries.map((d) => (
                <li key={d.id} className="rounded bg-surface px-2 py-1.5">
                  <span className={`mr-1.5 font-bold ${d.status === "sent" ? "text-ok" : "text-danger"}`}>{d.status === "sent" ? "送信済み" : "失敗"}</span>
                  {time(d.createdAt)} {d.storeName} → {d.recipientName}{d.target === "bot" && d.rooms.length ? `（${d.rooms.map((r) => r.name).join("・")}）` : ""}
                  <span className="ml-1 text-faint">新着{d.newReviews}件・総合点{d.scoreChanges}件</span>
                  {d.error ? <div className="text-danger">{d.error}</div> : null}
                </li>
              ))}
              {!log.deliveries.length ? <li className="text-faint">まだ送信はありません</li> : null}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-[11px] font-bold text-faint">検出（新着口コミ・総合点の変化）</h3>
            <ul className="flex flex-col gap-1.5 text-[11px]">
              {log.events.map((e) => (
                <li key={e.id} className="rounded bg-surface px-2 py-1.5">
                  <span className="mr-1.5 font-bold">{ALERT_STATUS_LABELS[e.status] ?? e.status}</span>
                  {time(e.createdAt)} {siteName(e.source)} {e.summary}
                  {e.reason ? <span className="ml-1 text-faint">（{e.reason}）</span> : null}
                </li>
              ))}
              {!log.events.length ? <li className="text-faint">まだありません</li> : null}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
