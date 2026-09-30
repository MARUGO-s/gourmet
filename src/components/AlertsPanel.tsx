import { useCallback, useEffect, useState } from "react";
import { getAlertLog, getAlertSettings, getMtalkRecipients, saveAlertSetting } from "../api";
import type { AlertDelivery, AlertEvent, AlertRecipient, AlertSetting, MtalkRecipient, SourceMeta } from "../types";
import { ALERT_LIMITS, ALERT_STATUS_LABELS } from "../../supabase/functions/_shared/review-alerts.js";

type Props = { sources: SourceMeta[] };
type Draft = { newReviews: boolean; scoreChanges: boolean; recipients: AlertRecipient[] };
const draftOf = (s: AlertSetting): Draft => ({ newReviews: s.newReviews, scoreChanges: s.scoreChanges, recipients: s.recipients });
const sameDraft = (a: Draft, b: Draft) => a.newReviews === b.newReviews && a.scoreChanges === b.scoreChanges
  && a.recipients.map((r) => r.id).sort().join() === b.recipients.map((r) => r.id).sort().join();
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const inputClass = "rounded border border-line bg-card px-2 py-1 text-[11px] font-semibold focus:border-brand focus:outline-none";

// 口コミ通知: 取り込みで新しい口コミが入ったとき・食べログの総合点が変わったときに M-talk の「AI分析」Bot から送る。店舗ごとの設定と履歴
export default function AlertsPanel({ sources }: Props) {
  const [settings, setSettings] = useState<AlertSetting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [people, setPeople] = useState<MtalkRecipient[] | null>(null);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [log, setLog] = useState<{ deliveries: AlertDelivery[]; events: AlertEvent[] }>({ deliveries: [], events: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const siteName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([getAlertSettings(), getAlertLog()]);
      setSettings(s.settings);
      setLog(l);
      setDrafts({});
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "読み込めませんでした", error: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    getMtalkRecipients().then(({ recipients }) => setPeople(recipients)).catch((e) => setPeopleError(e instanceof Error ? e.message : "M-talk の送信先を読み込めませんでした"));
  }, []);

  const setDraft = (s: AlertSetting, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [s.storeId]: { ...(d[s.storeId] ?? draftOf(s)), ...patch } }));

  const save = async (s: AlertSetting) => {
    const draft = drafts[s.storeId] ?? draftOf(s);
    setBusy(s.storeId);
    setNotice(null);
    try {
      const { setting } = await saveAlertSetting({ storeId: s.storeId, ...draft });
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
          <p>取り込み（自動取得・取得依頼のどちらでも）で<b>新しい口コミ</b>が入ったとき、または<b>食べログの総合点</b>が前回から変わったときに、M-talk の「AI分析」Botから送ります。1通に口コミ{ALERT_LIMITS.reviewsPerMessage}件まで（残りは「ほか N件」）。同じ口コミ・同じ変化は二度送りません。</p>
          <p className="mt-2 rounded bg-surface px-3 py-2 text-[11px] font-semibold text-faint">設定していない店舗は「両方オン・送信先 itagawa yoshito」です。通知を始める前から取り込まれていた口コミと、投稿から60日より前の口コミは送りません。</p>
        </div>
        {notice ? (
          <p className={`mx-5 mt-3 rounded px-3 py-2 text-[11px] font-bold ${notice.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{notice.error ? "⚠" : "✓"} {notice.text}</p>
        ) : null}
        {peopleError ? <p className="mx-5 mt-3 rounded bg-warn-soft px-3 py-2 text-[11px] font-semibold text-warn">⚠ {peopleError}（保存済みの送信先はそのまま使われます）</p> : null}
        <ul className="mt-3 divide-y divide-line">
          {settings.map((s) => {
            const draft = drafts[s.storeId] ?? draftOf(s);
            const dirty = !sameDraft(draft, draftOf(s));
            const choices = (people ?? []).filter((p) => !draft.recipients.some((r) => r.id === p.id));
            const pick = adding[s.storeId] ?? "";
            return (
              <li key={s.storeId} className="flex flex-col gap-2 px-5 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[12px] font-bold">{s.storeName}</span>
                  {s.isDefault ? <span className="rounded bg-surface px-1.5 py-0.5 text-[9px] font-bold text-faint">既定</span> : null}
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
                  <span className="text-faint">送信先:</span>
                  {draft.recipients.length ? draft.recipients.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 font-semibold">
                      {r.name}
                      <button aria-label={`${r.name}を外す`} onClick={() => setDraft(s, { recipients: draft.recipients.filter((x) => x.id !== r.id) })} className="text-faint hover:text-danger">×</button>
                    </span>
                  )) : <span className="font-semibold text-warn">なし</span>}
                  {people && draft.recipients.length < ALERT_LIMITS.recipients ? (
                    <>
                      <select aria-label="送信先を追加" value={pick} onChange={(e) => setAdding((a) => ({ ...a, [s.storeId]: e.target.value }))} className={inputClass}>
                        <option value="">送信先を追加…</option>
                        {choices.map((p) => <option key={p.id} value={p.id}>{p.username}{p.stores.length ? `（${p.stores.join("・")}）` : ""}</option>)}
                      </select>
                      <button disabled={!pick} onClick={() => {
                        const p = people.find((x) => x.id === pick);
                        if (p) setDraft(s, { recipients: [...draft.recipients, { id: p.id, name: p.username }] });
                        setAdding((a) => ({ ...a, [s.storeId]: "" }));
                      }} className="rounded border border-line px-2 py-0.5 font-bold text-subtle disabled:opacity-40">追加</button>
                    </>
                  ) : null}
                </div>
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
            <h3 className="mb-2 text-[11px] font-bold text-faint">送信（送信先ごと）</h3>
            <ul className="flex flex-col gap-1.5 text-[11px]">
              {log.deliveries.map((d) => (
                <li key={d.id} className="rounded bg-surface px-2 py-1.5">
                  <span className={`mr-1.5 font-bold ${d.status === "sent" ? "text-ok" : "text-danger"}`}>{d.status === "sent" ? "送信済み" : "失敗"}</span>
                  {time(d.createdAt)} {d.storeName} → {d.recipientName}
                  <span className="ml-1 text-faint">（新着{d.newReviews}件・総合点{d.scoreChanges}件）</span>
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
