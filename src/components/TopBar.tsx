type Props = {
  title: string;
  subtitle: string;
  syncing: boolean;
  syncDisabled?: boolean;
  lastSync: string | null;
  demo: boolean;
  onSync: () => void;
};

import AuthButton from "./AuthButton";

export default function TopBar({ title, subtitle, syncing, syncDisabled, lastSync, demo, onSync }: Props) {
  const lastSyncLabel = lastSync
    ? new Date(lastSync).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })
    : "—";
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-card px-6 py-4">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] leading-tight font-bold tracking-tight">{title}</h1>
        <p className="mt-0.5 text-[11px] font-medium text-faint">
          {subtitle} · 最終同期 {lastSyncLabel}
        </p>
      </div>
      {demo ? (
        <span className="rounded bg-warn-soft px-2 py-1 text-[10px] font-bold text-warn">
          デモデータ
        </span>
      ) : null}
      <button
        onClick={onSync}
        disabled={syncing || syncDisabled}
        title={syncDisabled ? "アプリにログインし、対象サイトのアカウントを登録してください" : undefined}
        className="flex items-center gap-2 rounded-md bg-brand px-3.5 py-2 text-[12px] font-bold text-white transition hover:opacity-90 disabled:opacity-50"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          className={syncing ? "animate-spin" : ""}
        >
          <path d="M21 12a9 9 0 1 1-2.6-6.3" />
          <path d="M21 3v6h-6" />
        </svg>
        {syncing ? "同期中…" : "今すぐ同期"}
      </button>
      <AuthButton />
    </header>
  );
}
