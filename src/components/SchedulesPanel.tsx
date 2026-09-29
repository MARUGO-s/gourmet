import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteSchedule, getSchedules, saveSchedule } from "../api";
import type { CredentialRow, FetchSchedule, ScheduleMode, SourceMeta, Store, StoreKeys } from "../types";
import { filterByStore, storeLabelFor } from "../../supabase/functions/_shared/stores.js";
import StorePicker, { commitPick, emptyPick } from "./StorePicker";
import {
  AGENT_WINDOW_NOTE, INTERVAL_CHOICES, MODE_LABELS, SCHEDULE_MODES, SCHEDULE_SOURCES, SUPPORTED_SCHEDULE_SOURCES, WEEKDAY_LABELS,
  describeSchedule, timeOutsideAgentWindow,
} from "../../supabase/functions/_shared/fetch-schedules.js";

type Props = {
  sources: SourceMeta[]; credentials: CredentialRow[];
  // 店舗マスタ・表示中の店舗の店舗コード（null=全店舗）・追加時の既定の店舗
  stores: Store[]; scopeKeys: StoreKeys | null; defaultStoreId: string; onStoresChanged: () => void;
};
type Draft = { mode: ScheduleMode; intervalHours: number; timeOfDay: string; weekday: number; enabled: boolean };
type Row = { key: string; source: string; storeId: string; label: string; schedule: FetchSchedule | null };

const DEFAULT_DRAFT: Draft = { mode: "off", intervalHours: 6, timeOfDay: "10:00", weekday: 1, enabled: true };
const keyOf = (source: string, storeId: string) => `${source}/${storeId}`;
const draftOf = (s: FetchSchedule | null): Draft => s ? {
  mode: s.mode, intervalHours: s.intervalHours ?? DEFAULT_DRAFT.intervalHours, timeOfDay: s.timeOfDay ?? DEFAULT_DRAFT.timeOfDay,
  weekday: s.weekday ?? DEFAULT_DRAFT.weekday, enabled: s.enabled,
} : DEFAULT_DRAFT;
const sameDraft = (a: Draft, b: Draft) => a.mode === b.mode && a.enabled === b.enabled
  && (a.mode !== "hourly_interval" || a.intervalHours === b.intervalHours)
  && (a.mode !== "daily" && a.mode !== "weekly" || a.timeOfDay === b.timeOfDay)
  && (a.mode !== "weekly" || a.weekday === b.weekday);
// 日本時間で表示（例: 9/30(水) 10:00）
const jst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const formatJst = (iso: string | null | undefined) => iso ? jst.format(new Date(iso)) : "—";
const inputClass = "rounded border border-line bg-card px-2 py-1 text-[11px]";

// 店舗×サイトごとの自動取得の周期。保存した周期で、Grok Botが予定時刻を過ぎた設定を取得依頼にする。
export default function SchedulesPanel({ sources, credentials, stores, scopeKeys, defaultStoreId, onStoresChanged }: Props) {
  const [schedules, setSchedules] = useState<FetchSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [custom, setCustom] = useState({ source: SCHEDULE_SOURCES[0], pick: emptyPick(defaultStoreId) });
  const allSites = useMemo(() => stores.flatMap((s) => s.sites), [stores]);
  const [extra, setExtra] = useState<{ source: string; storeId: string }[]>([]);
  const srcMap = new Map(sources.map((s) => [s.id, s]));

  const refresh = useCallback(() => {
    setLoading(true);
    getSchedules().then(({ schedules: rows }) => setSchedules(rows))
      .catch((e) => setNotice({ text: e instanceof Error ? e.message : "自動取得の設定を読み込めませんでした", error: true }))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // 登録済みアカウント（店舗×サイト）＋保存済みの設定＋この画面で追加した店舗
  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    const add = (source: string, storeId: string, label = "") => {
      if (!SCHEDULE_SOURCES.includes(source)) return;
      const key = keyOf(source, storeId);
      const prev = map.get(key);
      map.set(key, { key, source, storeId, label: prev?.label || label, schedule: prev?.schedule ?? null });
    };
    credentials.forEach((c) => { if (c.source !== "ikyu" || /^\d{6}$/.test(c.storeKey)) add(c.source, c.storeKey, c.label); });
    extra.forEach((x) => add(x.source, x.storeId));
    schedules.forEach((s) => { add(s.source, s.storeId); map.get(keyOf(s.source, s.storeId))!.schedule = s; });
    const order = (r: Row) => SCHEDULE_SOURCES.indexOf(r.source);
    // 表示中の店舗に割り当てた店舗コードだけ（全店舗では全件）。店舗名は店舗マスタの名前
    return filterByStore([...map.values()], scopeKeys, (r) => r.storeId)
      .map((r) => ({ ...r, label: storeLabelFor(stores, allSites, r.source, r.storeId) }))
      .sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label, "ja") || a.storeId.localeCompare(b.storeId));
  }, [credentials, schedules, extra, scopeKeys, stores, allSites]);

  const setDraft = (key: string, base: Draft, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [key]: { ...(d[key] ?? base), ...patch } }));

  const onSave = async (row: Row, draft: Draft) => {
    setBusy(row.key);
    setNotice(null);
    try {
      const { schedule } = await saveSchedule({ source: row.source, storeId: row.storeId, mode: draft.mode, enabled: draft.enabled,
        ...(draft.mode === "hourly_interval" ? { intervalHours: draft.intervalHours } : {}),
        ...(draft.mode === "daily" || draft.mode === "weekly" ? { timeOfDay: draft.timeOfDay } : {}),
        ...(draft.mode === "weekly" ? { weekday: draft.weekday } : {}) });
      setSchedules((list) => [...list.filter((s) => s.id !== schedule.id), schedule]);
      setDrafts((d) => { const next = { ...d }; delete next[row.key]; return next; });
      setNotice({ text: `保存しました（${srcMap.get(row.source)?.name ?? row.source}・${describeSchedule(schedule)}）`, error: false });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "保存できませんでした", error: true });
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (row: Row) => {
    if (!row.schedule) return;
    setBusy(row.key);
    try {
      await deleteSchedule(row.schedule.id);
      setSchedules((list) => list.filter((s) => s.id !== row.schedule!.id));
      setDrafts((d) => { const next = { ...d }; delete next[row.key]; return next; });
      setNotice({ text: "設定を削除しました", error: false });
    } catch {
      setNotice({ text: "削除できませんでした", error: true });
    } finally {
      setBusy(null);
    }
  };

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // 店舗IDが未設定なら、その店舗の割り当てに保存してから行を追加する
      const { key, created } = await commitPick(stores, custom.source, custom.pick);
      if (created) onStoresChanged();
      setExtra((x) => [...x, { source: custom.source, storeId: key }]);
      setCustom({ ...custom, pick: emptyPick(custom.pick.storeId) });
      setNotice(null);
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "店舗を追加できませんでした", error: true });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-md border border-line bg-card">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-bold tracking-tight">自動取得の設定</h2>
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{rows.length} 件</span>
          <button onClick={refresh} className="ml-auto rounded border border-line px-2 py-1 text-[11px] font-bold text-subtle">{loading ? "更新中…" : "更新"}</button>
        </header>
        <div className="px-5 pt-4 text-[12px] leading-relaxed text-subtle">
          <p>店舗×サイトごとに、Grok Botへ自動で取得を依頼する周期を設定します。予定時刻になると「取得依頼」に登録され、通常の依頼と同じように取得・取り込みされます（同じ店舗・サイトの依頼が処理中の場合は、その回は依頼しません）。</p>
          <p className="mt-2 rounded bg-warn-soft px-3 py-2 text-[11px] font-semibold text-warn">🕘 {AGENT_WINDOW_NOTE}</p>
        </div>
        {notice ? (
          <p className={`mx-5 mt-3 rounded px-3 py-2 text-[11px] font-bold ${notice.error ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>{notice.error ? "⚠" : "✓"} {notice.text}</p>
        ) : null}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-line">
                {["サイト", "店舗", "周期", "有効", "次回予定", "前回実行", ""].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-[10px] font-bold tracking-wide text-faint uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const s = srcMap.get(row.source);
                const saved = draftOf(row.schedule);
                const draft = drafts[row.key] ?? saved;
                const dirty = !row.schedule ? draft.mode !== "off" || !sameDraft(draft, saved) : !sameDraft(draft, saved);
                const supported = SUPPORTED_SCHEDULE_SOURCES.includes(row.source);
                const timed = draft.mode === "daily" || draft.mode === "weekly";
                return (
                  <tr key={row.key} className="border-b border-line align-top last:border-b-0 hover:bg-surface">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold">
                        <span className="h-2 w-2 rounded-full" style={{ background: s?.color ?? "#cbd5e1" }} />
                        {s?.name ?? row.source}
                      </span>
                      {!supported ? <span className="ml-1.5 rounded bg-surface px-1.5 py-0.5 text-[9px] font-bold text-faint" title="Grok Botの読み取りが未対応のため、保存しても取得は失敗する場合があります">準備中</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] font-semibold">
                      {row.label}
                      <span className="ml-1 text-[10px] text-faint">{row.storeId || "既定"}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <select aria-label="周期" value={draft.mode} onChange={(e) => setDraft(row.key, saved, { mode: e.target.value as ScheduleMode })} className={inputClass}>
                          {SCHEDULE_MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
                        </select>
                        {draft.mode === "hourly_interval" ? (
                          <label className="inline-flex items-center gap-1 text-[11px] text-subtle">
                            <select aria-label="間隔（時間）" value={draft.intervalHours} onChange={(e) => setDraft(row.key, saved, { intervalHours: Number(e.target.value) })} className={inputClass}>
                              {INTERVAL_CHOICES.map((h) => <option key={h} value={h}>{h}</option>)}
                            </select>時間ごと
                          </label>
                        ) : null}
                        {draft.mode === "weekly" ? (
                          <label className="inline-flex items-center gap-1 text-[11px] text-subtle">毎週
                            <select aria-label="曜日" value={draft.weekday} onChange={(e) => setDraft(row.key, saved, { weekday: Number(e.target.value) })} className={inputClass}>
                              {WEEKDAY_LABELS.map((w, i) => <option key={w} value={i}>{w}曜</option>)}
                            </select>
                          </label>
                        ) : null}
                        {timed ? (
                          <label className="inline-flex items-center gap-1 text-[11px] text-subtle">{draft.mode === "daily" ? "毎日" : ""}
                            <input aria-label="時刻（日本時間）" type="time" step={300} value={draft.timeOfDay} onChange={(e) => setDraft(row.key, saved, { timeOfDay: e.target.value })} className={inputClass} />
                          </label>
                        ) : null}
                      </div>
                      {timed && timeOutsideAgentWindow(draft.timeOfDay) ? (
                        <p className="mt-1 text-[10px] font-semibold text-warn">稼働時間外のため、次の9:00以降に取得されます</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5">
                      <input type="checkbox" aria-label="有効" checked={draft.enabled} disabled={draft.mode === "off"} onChange={(e) => setDraft(row.key, saved, { enabled: e.target.checked })} />
                    </td>
                    <td className="px-4 py-2.5 text-[11px] whitespace-nowrap">
                      {row.schedule?.nextDueAt ? <span className="font-bold">{formatJst(row.schedule.nextDueAt)}</span> : <span className="text-faint">{row.schedule && row.schedule.mode !== "off" && !row.schedule.enabled ? "停止中" : "—"}</span>}
                      {row.schedule ? <p className="text-[10px] text-faint">{describeSchedule(row.schedule)}</p> : null}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] whitespace-nowrap text-subtle">{formatJst(row.schedule?.lastEnqueuedAt)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => void onSave(row, draft)} disabled={busy === row.key || !dirty}
                        className="rounded-md bg-brand px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-40">{busy === row.key ? "保存中…" : "保存"}</button>
                      {row.schedule ? (
                        <button onClick={() => void onDelete(row)} disabled={busy === row.key} className="ml-1 rounded px-2 py-1 text-[10px] font-bold text-danger transition hover:bg-danger-soft">削除</button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr><td colSpan={7} className="px-5 py-6 text-center text-[12px] font-semibold text-faint">{loading ? "読み込み中…" : "店舗のアカウントが未登録です。下の欄から店舗を追加して設定できます。"}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <form className="flex flex-wrap items-end gap-2 border-t border-line px-5 py-4 text-[11px]" onSubmit={onAdd}>
          <label className="flex flex-col gap-1 font-bold text-subtle">サイト
            <select value={custom.source} onChange={(e) => setCustom({ source: e.target.value, pick: emptyPick(custom.pick.storeId) })} className="rounded border border-line bg-card px-2 py-1.5 font-normal text-ink">
              {SCHEDULE_SOURCES.map((id) => <option key={id} value={id}>{srcMap.get(id)?.name ?? id}{SUPPORTED_SCHEDULE_SOURCES.includes(id) ? "" : "（準備中）"}</option>)}
            </select>
          </label>
          <StorePicker compact stores={stores} source={custom.source} sourceName={srcMap.get(custom.source)?.name ?? custom.source} value={custom.pick} onChange={(pick) => setCustom({ ...custom, pick })} />
          <button type="submit" disabled={!custom.pick.storeId} className="rounded-md border border-brand px-3 py-2 font-bold text-brand disabled:opacity-50">この店舗を追加</button>
          <span className="text-[10px] text-faint">アカウント未登録の店舗も設定できます（取得にはアカウント管理での登録が必要です）</span>
        </form>
      </section>
    </div>
  );
}
