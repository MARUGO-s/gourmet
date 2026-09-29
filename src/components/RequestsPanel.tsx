import { useState } from "react";
import type { AgentRequest, AgentRequestAction, CredentialRow, SourceMeta } from "../types";
import { ACTION_LABELS, AGENT_POLL_MINUTES, INGEST_NOTE, formatTime, openRequestFor, requestLabel, statusTone } from "../lib/agent-requests";

type Props = {
  sources: SourceMeta[];
  credentials: CredentialRow[];
  requests: AgentRequest[];
  loading: boolean;
  busyKey: string | null;
  onRequest: (source: string, storeId: string, action?: AgentRequestAction, params?: { fromMonth?: string; note?: string }) => void;
  onRefresh: () => void;
};

const ACTIONS = Object.keys(ACTION_LABELS) as AgentRequestAction[];
const thisMonth = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).slice(0, 7);

function resultSummary(r: AgentRequest) {
  if (r.status === "failed") return r.error ?? "失敗しました";
  if (r.status === "done") {
    const res = r.result ?? {};
    const parts = Object.entries(res).filter(([, v]) => typeof v === "number" || typeof v === "string").slice(0, 6).map(([k, v]) => `${k}: ${v}`);
    return parts.length ? parts.join(" / ") : "取り込み完了";
  }
  if (r.status === "claimed") return `Grok Botが取得中です（開始 ${formatTime(r.claimedAt)}${r.attempts > 1 ? `・${r.attempts}回目` : ""}）`;
  return `Grok Botの確認待ちです（約${AGENT_POLL_MINUTES}分ごとに確認）`;
}

// 店舗×サイトごとの取得依頼と、依頼の履歴（依頼中 / 取得中 / 完了 / 失敗）
export default function RequestsPanel({ sources, credentials, requests, loading, busyKey, onRequest, onRefresh }: Props) {
  const names = new Map(sources.map((s) => [s.id, s.name]));
  const [actions, setActions] = useState<Record<string, AgentRequestAction>>({});
  const [fromMonth, setFromMonth] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState({ source: sources[0]?.id ?? "tabelog", storeId: "", action: "sync_now" as AgentRequestAction, fromMonth: "" });
  const storeLabel = (source: string, storeId: string) => {
    const c = credentials.find((x) => x.source === source && x.storeKey === storeId);
    return c?.label || (storeId ? `店舗 ${storeId}` : "既定の店舗");
  };
  const submit = (source: string, storeId: string, action: AgentRequestAction, month?: string) =>
    onRequest(source, storeId, action, action === "backfill" ? { fromMonth: month } : undefined);

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-md border border-line bg-card p-5">
        <h2 className="text-[13px] font-bold">Grok Botへの取得依頼</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-subtle">
          {INGEST_NOTE}。ここで登録した依頼を、Grok Botが約{AGENT_POLL_MINUTES}分ごとに確認して取得・取り込みを行います（開始まで数分かかります）。
          同じ店舗・サイト・内容の依頼は、完了するまで重ねて登録できません。24時間拾われなかった依頼は失敗になります。
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] font-bold text-faint">
                <th className="px-2 py-2">サイト</th><th className="px-2 py-2">店舗</th><th className="px-2 py-2">最終更新</th><th className="px-2 py-2">依頼内容</th><th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => {
                const key = `${c.source}/${c.storeKey}`;
                const action = actions[key] ?? "sync_now";
                const open = openRequestFor(requests, c.source, c.storeKey, action);
                return (
                  <tr key={c.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-2 font-bold">{names.get(c.source) ?? c.source}</td>
                    <td className="px-2 py-2">{storeLabel(c.source, c.storeKey)}{c.storeKey ? <span className="ml-1 text-[10px] text-faint">{c.storeKey}</span> : null}</td>
                    <td className="px-2 py-2 text-subtle">{formatTime(sources.find((s) => s.id === c.source)?.lastUpdatedAt)}</td>
                    <td className="px-2 py-2">
                      <select value={action} onChange={(e) => setActions({ ...actions, [key]: e.target.value as AgentRequestAction })} className="rounded border border-line bg-card px-2 py-1 text-[11px]">
                        {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
                      </select>
                      {action === "backfill" ? (
                        <input type="month" max={thisMonth()} value={fromMonth[key] ?? ""} onChange={(e) => setFromMonth({ ...fromMonth, [key]: e.target.value })} className="ml-2 rounded border border-line px-2 py-1 text-[11px]" aria-label="開始月" />
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {c.source === "ikyu" && !/^\d{6}$/.test(c.storeKey) ? (
                        <span className="rounded bg-warn-soft px-2 py-1 text-[10px] font-bold text-warn">店舗ID未設定（アカウント管理で登録し直してください）</span>
                      ) : open ? (
                        <span className={`rounded px-2 py-1 text-[10px] font-bold ${statusTone(open.status)}`}>{requestLabel(open.status)}</span>
                      ) : (
                        <button onClick={() => submit(c.source, c.storeKey, action, fromMonth[key])} disabled={busyKey === key || (action === "backfill" && !fromMonth[key])}
                          className="rounded-md bg-brand px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50">
                          {busyKey === key ? "送信中…" : "今すぐ取得を依頼"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!credentials.length ? <tr><td colSpan={5} className="px-2 py-4 text-center text-faint">店舗のアカウントが未登録です。下の欄から店舗コードを指定して依頼できます。</td></tr> : null}
            </tbody>
          </table>
        </div>
        <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4 text-[11px]" onSubmit={(e) => { e.preventDefault(); submit(custom.source, custom.storeId.trim(), custom.action, custom.fromMonth); }}>
          <label className="flex flex-col gap-1 font-bold text-subtle">サイト
            <select value={custom.source} onChange={(e) => setCustom({ ...custom, source: e.target.value })} className="rounded border border-line bg-card px-2 py-1.5 font-normal text-ink">
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 font-bold text-subtle">{custom.source === "ikyu" ? "店舗ID（6桁）" : "店舗コード（任意）"}
            <input value={custom.storeId} onChange={(e) => setCustom({ ...custom, storeId: e.target.value })} maxLength={40} className="w-40 rounded border border-line px-2 py-1.5 font-normal text-ink" />
          </label>
          <label className="flex flex-col gap-1 font-bold text-subtle">依頼内容
            <select value={custom.action} onChange={(e) => setCustom({ ...custom, action: e.target.value as AgentRequestAction })} className="rounded border border-line bg-card px-2 py-1.5 font-normal text-ink">
              {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
            </select>
          </label>
          {custom.action === "backfill" ? (
            <label className="flex flex-col gap-1 font-bold text-subtle">開始月
              <input type="month" max={thisMonth()} value={custom.fromMonth} onChange={(e) => setCustom({ ...custom, fromMonth: e.target.value })} className="rounded border border-line px-2 py-1.5 font-normal text-ink" />
            </label>
          ) : null}
          <button type="submit" disabled={busyKey === `${custom.source}/${custom.storeId.trim()}`} className="rounded-md border border-brand px-3 py-2 font-bold text-brand disabled:opacity-50">この内容で依頼</button>
        </form>
      </section>

      <section className="rounded-md border border-line bg-card">
        <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-bold tracking-tight">依頼の履歴</h2>
          <span className="text-[10px] text-faint">直近50件・処理待ちがある間は自動で更新します</span>
          <button onClick={onRefresh} className="ml-auto rounded border border-line px-2 py-1 text-[11px] font-bold text-subtle">{loading ? "更新中…" : "更新"}</button>
        </header>
        {requests.length ? (
          <ul className="divide-y divide-line">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-[12px]">
                <span className={`mt-0.5 rounded px-2 py-0.5 text-[10px] font-bold ${statusTone(r.status)}`}>{requestLabel(r.status)}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{names.get(r.source) ?? r.source} ・ {storeLabel(r.source, r.storeId)} ・ {ACTION_LABELS[r.action]}{r.params.fromMonth ? `（${r.params.fromMonth}〜${r.params.toMonth ?? ""}）` : ""}</p>
                  <p className={`mt-0.5 text-[11px] ${r.status === "failed" ? "text-danger" : "text-subtle"}`}>{resultSummary(r)}</p>
                </div>
                <div className="text-right text-[10px] text-faint">
                  <p>依頼 {formatTime(r.requestedAt)}</p>
                  {r.finishedAt ? <p>終了 {formatTime(r.finishedAt)}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-[12px] text-faint">{loading ? "読み込み中…" : "まだ依頼はありません"}</p>
        )}
      </section>
    </div>
  );
}
