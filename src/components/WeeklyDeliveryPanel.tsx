import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteWeeklySchedule, getAlertSettings, getWeeklySchedules, saveWeeklySchedule } from "../api";
import type { AlertSetting, Store, StoreBot, WeeklySchedule } from "../types";
import { WEEKDAY_LABELS, timeOutsideAgentWindow } from "../../supabase/functions/_shared/fetch-schedules.js";
import {
  WEEKLY_MAX_ATTEMPTS, WEEKLY_RETRY_MINUTES, WEEKLY_SCHEDULE_DEFAULT, WEEKLY_STATUS_LABELS, describeWeeklySchedule, parseRoomIds,
} from "../../supabase/functions/_shared/weekly-schedules.js";

type Props = { stores: Store[]; scope: string | null };
type Draft = { weekday: number; timeOfDay: string; enabled: boolean; includePdf: boolean; rooms: string };

const jst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const formatJst = (iso: string | null | undefined) => (iso ? jst.format(new Date(iso)) : "—");
const inputClass = "rounded border border-line bg-card px-2 py-1 text-[11px]";
const draftOf = (s: WeeklySchedule | null): Draft => ({
  weekday: s?.weekday ?? WEEKLY_SCHEDULE_DEFAULT.weekday, timeOfDay: s?.timeOfDay ?? WEEKLY_SCHEDULE_DEFAULT.timeOfDay,
  enabled: s?.enabled ?? WEEKLY_SCHEDULE_DEFAULT.enabled, includePdf: s?.includePdf ?? WEEKLY_SCHEDULE_DEFAULT.includePdf,
  rooms: (s?.roomIds ?? []).join(", "),
});
const sameDraft = (a: Draft, b: Draft) => a.weekday === b.weekday && a.timeOfDay === b.timeOfDay && a.enabled === b.enabled
  && a.includePdf === b.includePdf && a.rooms.replace(/\s/g, "") === b.rooms.replace(/\s/g, "");
const statusClass: Record<string, string> = { delivered: "text-ok", skipped: "text-faint", deferred: "text-warn", failed: "text-danger" };

// 店舗ごとの週報の配信予定（曜日・時刻・送り先ルーム）。保存した予定時刻を過ぎると、Grok Botが最新の取得データで週報を作り、
// GitHub Pages に週報 HTML を置いてから、M-talk の店舗Botとしてルームへ「週報を開く」カードを届ける。
export default function WeeklyDeliveryPanel({ stores, scope }: Props) {
  const [schedules, setSchedules] = useState<WeeklySchedule[]>([]);
  const [alerts, setAlerts] = useState<AlertSetting[]>([]);
  const [bots, setBots] = useState<StoreBot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [extra, setExtra] = useState<string[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      getWeeklySchedules().then(({ schedules: rows }) => setSchedules(rows)),
      // 送り先ルームの名前（口コミ通知と同じ店舗Bot）。読めなくても番号で設定できる
      getAlertSettings().then((s) => { setAlerts(s.settings); setBots(s.bots); }).catch(() => setBots(null)),
    ]).catch((e) => setNotice({ text: e instanceof Error ? e.message : "週報の配信設定を読み込めませんでした", error: true }))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const inScope = useCallback((storeId: string) => !scope || scope === "all" || scope === storeId, [scope]);
  const rows = useMemo(() => {
    const ids = [...new Set([...schedules.map((s) => s.storeId), ...extra])].filter(inScope);
    const order = new Map(stores.map((s, i) => [s.id, i]));
    return ids.map((id) => ({ storeId: id, store: stores.find((s) => s.id === id) ?? null, schedule: schedules.find((s) => s.storeId === id) ?? null }))
      .sort((a, b) => (order.get(a.storeId) ?? 999) - (order.get(b.storeId) ?? 999));
  }, [schedules, extra, stores, inScope]);
  const addable = stores.filter((s) => inScope(s.id) && !rows.some((r) => r.storeId === s.id));

  const roomsOf = (storeId: string) => {
    const bot = alerts.find((a) => a.storeId === storeId)?.bot;
    return bot ? bots?.find((b) => b.id === bot.id)?.rooms ?? [] : [];
  };
  const setDraft = (key: string, base: Draft, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [key]: { ...(d[key] ?? base), ...patch } }));

  const onSave = async (storeId: string, draft: Draft) => {
    setBusy(storeId);
    setNotice(null);
    try {
      const { schedule } = await saveWeeklySchedule({ storeId, weekday: draft.weekday, timeOfDay: draft.timeOfDay, enabled: draft.enabled, includePdf: draft.includePdf, roomIds: parseRoomIds(draft.rooms) });
      setSchedules((list) => [...list.filter((s) => s.storeId !== storeId), schedule]);
      setDrafts((d) => { const next = { ...d }; delete next[storeId]; return next; });
      setNotice({ text: `保存しました（${schedule.storeName ?? ""}・${describeWeeklySchedule(schedule)}${schedule.enabled ? "" : "・停止中"}）`, error: false });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "保存できませんでした", error: true });
    } finally {
      setBusy(null);
    }
  };
  const onDelete = async (schedule: WeeklySchedule) => {
    setBusy(schedule.storeId);
    try {
      await deleteWeeklySchedule(schedule.id);
      setSchedules((list) => list.filter((s) => s.id !== schedule.id));
      setExtra((x) => x.filter((id) => id !== schedule.storeId));
      setNotice({ text: "週報の配信設定を削除しました（配信されなくなります）", error: false });
    } catch {
      setNotice({ text: "削除できませんでした", error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-md border border-line bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
        <h2 className="text-[13px] font-bold tracking-tight">週報の配信</h2>
        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{rows.length} 件</span>
        <button onClick={refresh} className="ml-auto rounded border border-line px-2 py-1 text-[11px] font-bold text-subtle">{loading ? "更新中…" : "更新"}</button>
      </header>
      <div className="px-5 pt-4 text-[12px] leading-relaxed text-subtle">
        <p>店舗ごとに、週報（食べログ・一休）を M-talk の店舗Botからルームへ届ける曜日・時刻（日本時間）を設定します。予定時刻になると Grok Bot が最新の取得データで週報 HTML を作って公開し、「週報を開く」カードを届けます（同じ週は1回だけ）。</p>
        <p className="mt-1 text-[11px]">取得データがまだそろっていない場合は {WEEKLY_RETRY_MINUTES} 分ごとに確認し直します（最大 {WEEKLY_MAX_ATTEMPTS} 回）。送り先ルームを選ばない場合は「口コミ通知」の設定 → 店舗Botの店舗ルームの順に決まります。</p>
      </div>
      {notice ? (
        <p className={`mx-5 mt-3 rounded px-3 py-2 text-[11px] font-bold ${notice.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{notice.error ? "⚠" : "✓"} {notice.text}</p>
      ) : null}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-[12px]">
          <thead>
            <tr className="border-b border-line">
              {["店舗", "曜日・時刻", "送り先ルーム", "PDF", "有効", "次回予定", "前回の配信", ""].map((h) => (
                <th key={h} className="px-4 py-2.5 text-[10px] font-bold tracking-wide text-faint uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ storeId, store, schedule }) => {
              const saved = draftOf(schedule);
              const draft = drafts[storeId] ?? saved;
              const dirty = !schedule || !sameDraft(draft, saved);
              const rooms = roomsOf(storeId);
              const picked = new Set((() => { try { return parseRoomIds(draft.rooms) ?? []; } catch { return []; } })());
              return (
                <tr key={storeId} className="border-b border-line align-top last:border-b-0 hover:bg-surface">
                  <td className="px-4 py-2.5 text-[11px] font-semibold">{store?.name ?? schedule?.storeName ?? storeId}</td>
                  <td className="cell-wrap px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-subtle">毎週
                      <select aria-label="曜日" value={draft.weekday} onChange={(e) => setDraft(storeId, saved, { weekday: Number(e.target.value) })} className={inputClass}>
                        {WEEKDAY_LABELS.map((w, i) => <option key={w} value={i}>{w}曜</option>)}
                      </select>
                      <input aria-label="時刻（日本時間）" type="time" step={60} value={draft.timeOfDay} onChange={(e) => setDraft(storeId, saved, { timeOfDay: e.target.value })} className={inputClass} />
                    </div>
                    {timeOutsideAgentWindow(draft.timeOfDay) ? <p className="mt-1 text-[10px] font-semibold text-warn">稼働時間外のため、次の9:00以降に配信されます</p> : null}
                  </td>
                  <td className="cell-wrap px-4 py-2.5 text-[11px]">
                    {rooms.length ? (
                      <div className="flex flex-col gap-0.5">
                        {rooms.map((r) => (
                          <label key={r.id} className="inline-flex items-center gap-1">
                            <input type="checkbox" checked={picked.has(r.id)} onChange={(e) => {
                              const next = new Set(picked); if (e.target.checked) next.add(r.id); else next.delete(r.id);
                              setDraft(storeId, saved, { rooms: [...next].join(", ") });
                            }} />
                            {r.name}<span className="text-[10px] text-faint">#{r.id}{r.isStoreRoom ? "・店舗ルーム" : ""}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <input aria-label="ルーム番号" placeholder="例: 30（空欄＝既定）" value={draft.rooms} onChange={(e) => setDraft(storeId, saved, { rooms: e.target.value })} className={`${inputClass} w-36`} />
                    )}
                    {!picked.size ? <p className="mt-0.5 text-[10px] text-faint">未選択＝口コミ通知の設定どおり</p> : null}
                  </td>
                  <td className="px-4 py-2.5"><input type="checkbox" aria-label="PDFも添える" checked={draft.includePdf} onChange={(e) => setDraft(storeId, saved, { includePdf: e.target.checked })} /></td>
                  <td className="px-4 py-2.5"><input type="checkbox" aria-label="有効" checked={draft.enabled} onChange={(e) => setDraft(storeId, saved, { enabled: e.target.checked })} /></td>
                  <td className="px-4 py-2.5 text-[11px] whitespace-nowrap">
                    {schedule?.nextDueAt ? <span className="font-bold">{formatJst(schedule.nextDueAt)}</span> : <span className="text-faint">{schedule && !schedule.enabled ? "停止中" : "—"}</span>}
                    {schedule ? <p className="text-[10px] text-faint">{describeWeeklySchedule(schedule)}{schedule.working ? "・作成中" : ""}</p> : null}
                  </td>
                  <td className="cell-wrap px-4 py-2.5 text-[11px]">
                    {schedule?.lastStatus ? (
                      <>
                        <span className={`font-bold ${statusClass[schedule.lastStatus] ?? ""}`}>{WEEKLY_STATUS_LABELS[schedule.lastStatus]}</span>
                        <span className="ml-1 text-[10px] text-faint">{formatJst(schedule.lastFinishedAt)}</span>
                        {schedule.lastHtmlUrl ? <p><a href={schedule.lastHtmlUrl} target="_blank" rel="noreferrer" className="text-brand underline">週報を開く（{schedule.lastAsOf}）</a></p> : null}
                        {schedule.lastReason && schedule.lastStatus !== "delivered" ? <p className="text-[10px] text-subtle">{schedule.lastReason}</p> : null}
                      </>
                    ) : <span className="text-faint">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => void onSave(storeId, draft)} disabled={busy === storeId || !dirty}
                      className="rounded-md bg-brand px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-40">{busy === storeId ? "保存中…" : "保存"}</button>
                    {schedule ? <button onClick={() => void onDelete(schedule)} disabled={busy === storeId} className="ml-1 rounded px-2 py-1 text-[10px] font-bold text-danger transition hover:bg-danger-soft">削除</button> : null}
                  </td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr><td colSpan={8} className="cell-wrap px-5 py-6 text-center text-[12px] font-semibold text-faint">{loading ? "読み込み中…" : "週報の配信はまだ設定されていません。下の欄から店舗を追加してください。"}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <form className="flex flex-wrap items-end gap-2 border-t border-line px-5 py-4 text-[11px]" onSubmit={(e) => { e.preventDefault(); if (pick) { setExtra((x) => [...x, pick]); setPick(""); } }}>
        <label className="flex flex-col gap-1 font-bold text-subtle">店舗
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="rounded border border-line bg-card px-2 py-1.5 font-normal text-ink">
            <option value="">選んでください</option>
            {addable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button type="submit" disabled={!pick} className="rounded-md border border-brand px-3 py-2 font-bold text-brand disabled:opacity-50">この店舗の週報を設定</button>
        <span className="text-[10px] text-faint">週報は店舗に割り当てた食べログ・一休の取得データから作ります（店舗管理で割り当て）</span>
      </form>
    </section>
  );
}
