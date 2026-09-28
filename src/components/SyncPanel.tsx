import type { SourceMeta, SyncJob } from "../types";

type Props = {
  job: SyncJob | null;
  signedIn: boolean;
  sources: SourceMeta[];
  syncing: boolean;
  onAccounts: () => void;
  onSync: () => void;
};

export default function SyncPanel({ job, signedIn, sources, syncing, onAccounts, onSync }: Props) {
  const registered = sources.some((s) => s.id === "tabelog" && s.hasCredential);
  return (
    <section className="rounded-md border border-line bg-card p-5" aria-label="食べログ自動取得">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-bold">食べログ自動取得</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-subtle">
            評価・口コミ数・日別PV・月別予約組数を取得し、保存した数値まで確認します。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-faint">
            端末別PV・エリア順位・よく見られるページも取得します。取得できない項目は警告でお知らせします。
          </p>
        </div>
        {signedIn && registered ? (
          <button onClick={onSync} disabled={syncing} className="rounded-md bg-brand px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50">
            {syncing ? "取得中…" : "食べログを同期"}
          </button>
        ) : signedIn ? (
          <button onClick={onAccounts} className="rounded-md border border-brand px-4 py-2 text-[12px] font-bold text-brand">
            食べログのアカウントを登録
          </button>
        ) : (
          <p className="rounded bg-surface px-3 py-2 text-[12px] text-subtle">右上の「ログイン」から開始してください</p>
        )}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        「同期」でクラウドの取得待ちに登録します。通常は数分後に開始しますが、混雑時は遅れることがあります。画面やPCを閉じても処理は続きます。追加認証が必要な場合は停止してお知らせします。
      </p>
      {job ? (
        <div className="mt-4 border-t border-line pt-3" role="status" aria-live="polite">
          <p className={`text-[12px] font-bold ${job.status === "error" ? "text-danger" : job.status === "running" ? "text-brand" : "text-ok"}`}>
            {job.message}
          </p>
          {job.results.map((result) => (
            <div key={result.source} className="mt-2 rounded bg-surface px-3 py-2 text-[12px] leading-relaxed">
              <p className={`font-bold ${result.status === "error" ? "text-danger" : "text-ink"}`}>
                {sources.find((s) => s.id === result.source)?.name ?? result.source}：
                {result.status === "ok" ? "保存確認済み" : result.message ?? "取得に失敗しました"}
              </p>
              {result.summary ? (
                <p className="text-subtle">
                  評価 {result.summary.rating?.toFixed(2) ?? "—"} ／ 口コミ {result.summary.reviews?.toLocaleString() ?? "—"}件
                  ／ 日別PV {result.summary.dailyDays}日分 ／ 月別予約 {result.summary.monthlyMonths}か月分
                  {result.summary.latestPvDate ? `（PV最終日 ${result.summary.latestPvDate}）` : ""}
                </p>
              ) : null}
              {result.warning ? <p className="mt-1 font-medium text-warn">注意：{result.warning}</p> : null}
            </div>
          ))}
          {job.finishedAt ? <p className="mt-2 text-[11px] text-faint">処理終了：{new Date(job.finishedAt).toLocaleString("ja-JP")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
