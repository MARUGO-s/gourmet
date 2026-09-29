import type { SourceMeta, SyncJob } from "../types";
import type { SyncState } from "../lib/sync-status";

type Props = {
  job: SyncJob | null;
  signedIn: boolean;
  sources: SourceMeta[];
  syncState: SyncState;
  onAccounts: () => void;
  onSync: () => void;
};

export default function SyncPanel({ job, signedIn, sources, syncState, onAccounts, onSync }: Props) {
  const registered = sources.some((s) => s.id === "tabelog" && s.hasCredential);
  const queued = syncState.phase === "queued";
  const partial = job?.results.some(result => result.status === "partial");
  const waitingMinutes = job ? Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 60000)) : 0;
  return (
    <section className="rounded-md border border-line bg-card p-5" aria-label="食べログ自動取得">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-bold">食べログ自動取得</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-subtle">
            管理画面の口コミ・個別評価・店舗返信・日別PV・月別予約組数を取得し、保存結果まで確認します。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-faint">
            管理画面で選べる過去の期間も取得します。店舗総合点と公開口コミ総数は自店舗ページから取り、個別口コミの点数や本文とは別に表示します。本文が掲載されていない口コミは点数のみのままです。
          </p>
        </div>
        {signedIn && registered ? (
          <button onClick={onSync} disabled={syncState.busy} className="rounded-md bg-brand px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50">
            {syncState.busy ? syncState.label : "食べログを同期"}
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
        「同期」でクラウドへ起動を依頼します。サーバーの準備中は「開始待ち」、サイトへのアクセス開始後は「取得中」と表示します。混雑で開始が遅れる場合があります。画面やPCを閉じても依頼は保持され、失敗・完了の結果も再表示できます。追加認証が必要な場合は停止します。
      </p>
      {job ? (
        <div className="mt-4 border-t border-line pt-3" role="status" aria-live="polite">
          <p className={`text-[12px] font-bold ${job.status === "error" ? "text-danger" : queued || partial ? "text-warn" : job.status === "running" ? "text-brand" : "text-ok"}`}>
            {queued ? "開始待ち：依頼は受付済みですが、サイトへのアクセスはまだ始まっていません" : job.message}
          </p>
          {queued ? <p className="mt-1 text-[11px] leading-relaxed text-subtle">{job.message}</p> : null}
          {queued && Number.isFinite(waitingMinutes) ? <p className="mt-1 text-[11px] leading-relaxed text-subtle">
            受付：{new Date(job.startedAt).toLocaleString("ja-JP")}（約{waitingMinutes}分経過）。同期を押し直す必要はありません。
            {waitingMinutes >= 5 ? " 起動待ちが続いています。20分以内に開始しなければ待機を終了してお知らせします。管理者はActionsの実行状況を確認してください。" : ""}
          </p> : null}
          {job.results.map((result) => (
            <div key={result.source} className="mt-2 rounded bg-surface px-3 py-2 text-[12px] leading-relaxed">
              <p className={`font-bold ${result.status === "error" ? "text-danger" : result.status === "partial" ? "text-warn" : "text-ink"}`}>
                {sources.find((s) => s.id === result.source)?.name ?? result.source}：
                {result.status === "ok" ? "保存確認済み" : result.status === "partial" ? "一部取得・保存確認済み" : result.message ?? "取得に失敗しました"}
              </p>
              {result.summary ? (
                <p className="text-subtle">
                  評価 {result.summary.rating?.toFixed(2) ?? "未取得"} ／ 口コミ {result.summary.reviews == null ? "未取得" : `${result.summary.reviews.toLocaleString()}件`}
                  ／ 日別PV {result.summary.dailyDays}日分 ／ 月別予約 {result.summary.monthlyMonths}か月分
                  {result.summary.latestPvDate ? `（PV最終日 ${result.summary.latestPvDate}）` : ""}
                  {result.summary.ownerReviewEntries != null ? ` ／ 管理画面の口コミ ${result.summary.ownerReviewGroups ?? "—"}件・${result.summary.ownerReviewEntries}投稿` : ""}
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
