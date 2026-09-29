import type { AgentRequest, CredentialRow, SourceMeta } from "../types";
import { AGENT_POLL_MINUTES, INGEST_NOTE, formatTime, openRequestFor, requestLabel, statusTone } from "../lib/agent-requests";

type Props = {
  filter: string;
  signedIn: boolean;
  sources: SourceMeta[];
  credentials: CredentialRow[];
  requests: AgentRequest[];
  busyKey: string | null;
  onRequest: (source: string, storeId: string) => void;
  onRequests: () => void;
  onAccounts: () => void;
};

const storeName = (c: CredentialRow) => c.label || (c.storeKey ? `店舗 ${c.storeKey}` : "既定の店舗");

// ダッシュボード上部: 取り込み元（Grok Bot）と最終更新、店舗ごとの「今すぐ取得を依頼」
export default function IngestPanel({ filter, signedIn, sources, credentials, requests, busyKey, onRequest, onRequests, onAccounts }: Props) {
  const shown = filter === "all" ? sources : sources.filter((s) => s.id === filter);
  return (
    <section className="rounded-md border border-line bg-card p-5" aria-label="データの取り込み">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-bold">{INGEST_NOTE}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-subtle">
            すべてのサイトのPV・予約・評価・口コミは、Grok Botがログイン済みのブラウザで各サイトの管理画面から取得し、このアプリへ取り込みます。アプリからサイトへログイン・取得はしません。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-faint">
            「今すぐ取得を依頼」はGrok Botへの依頼の登録です。Grok Botは約{AGENT_POLL_MINUTES}分ごとに依頼を確認するため、開始まで数分かかります。
          </p>
        </div>
        {signedIn ? (
          <div className="flex gap-2">
            <button onClick={onRequests} className="rounded-md border border-brand px-3 py-2 text-[12px] font-bold text-brand">依頼の履歴</button>
            <button onClick={onAccounts} className="rounded-md border border-line px-3 py-2 text-[12px] font-bold text-subtle">店舗のアカウント</button>
          </div>
        ) : (
          <p className="rounded bg-surface px-3 py-2 text-[12px] text-subtle">右上の「ログイン」から開始してください（未ログイン時はデモ表示）</p>
        )}
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((s) => {
          const stores = credentials.filter((c) => c.source === s.id);
          return (
            <div key={s.id} className="rounded border border-line px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                <span className="text-[12px] font-bold">{s.name}</span>
                <span className="ml-auto text-[10px] font-semibold text-faint">{INGEST_NOTE}</span>
              </div>
              <p className="mt-1 text-[11px] text-subtle">最終更新：{s.lastUpdatedAt ? formatTime(s.lastUpdatedAt) : signedIn ? "まだ取り込まれていません" : "—"}</p>
              {signedIn ? (
                stores.length ? (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {stores.map((c) => {
                      const open = openRequestFor(requests, s.id, c.storeKey);
                      const key = `${s.id}/${c.storeKey}`;
                      return (
                        <li key={c.id} className="flex items-center gap-2 text-[11px]">
                          <span className="min-w-0 flex-1 truncate font-semibold" title={storeName(c)}>{storeName(c)}</span>
                          {s.id === "ikyu" && !/^\d{6}$/.test(c.storeKey) ? (
                            <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-bold text-warn">店舗ID未設定（登録し直してください）</span>
                          ) : open ? (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${statusTone(open.status)}`} title={`依頼 ${formatTime(open.requestedAt)}`}>{requestLabel(open.status)}</span>
                          ) : (
                            <button onClick={() => onRequest(s.id, c.storeKey)} disabled={busyKey === key} className="rounded bg-brand px-2 py-1 text-[10px] font-bold text-white disabled:opacity-50">
                              {busyKey === key ? "送信中…" : "今すぐ取得を依頼"}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-faint">店舗のアカウントが未登録です（「取得依頼」から店舗コードを指定して依頼することもできます）</p>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
