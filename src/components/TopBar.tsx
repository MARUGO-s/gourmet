import type { ReactNode } from "react";
import AuthButton from "./AuthButton";

type Props = {
  title: string;
  subtitle: string;
  lastSync: string | null;
  demo: boolean;
  signedIn: boolean;
  openRequests: number;
  onRequests: () => void;
  // 店舗の切り替え（ログイン中で店舗を選択済みのとき）
  switcher?: ReactNode;
  // スマートフォン幅のメニュー（ドロワー）を開く
  onMenu?: () => void;
  menuOpen?: boolean;
};

// すべてのサイトは Grok Bot が取り込む。アプリからは取得せず、「取得を依頼」で依頼だけを登録する。
export default function TopBar({ title, subtitle, lastSync, demo, signedIn, openRequests, onRequests, switcher, onMenu, menuOpen = false }: Props) {
  const lastSyncLabel = lastSync
    ? new Date(lastSync).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })
    : "—";
  return (
    <header className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-card px-4 py-4 md:px-6">
      {onMenu ? (
        <button
          type="button"
          onClick={onMenu}
          aria-label="メニュー"
          aria-controls="mobile-nav"
          aria-expanded={menuOpen}
          title="メニュー"
          className="no-print mobile-nav-toggle -ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line text-ink hover:bg-surface md:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      ) : null}
      <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] md:basis-0">
        <h1 className="truncate text-[15px] leading-tight font-bold tracking-tight">{title}</h1>
        <p className="mt-0.5 text-[11px] font-medium text-faint">
          {subtitle} · データはGrok Botが取り込み · 最終取り込み {lastSyncLabel}
        </p>
      </div>
      {switcher}
      {demo ? (
        <span className="rounded bg-warn-soft px-2 py-1 text-[10px] font-bold text-warn">
          デモデータ
        </span>
      ) : null}
      <button
        onClick={onRequests}
        disabled={!signedIn}
        title={signedIn ? "Grok Botへ取得を依頼します（約5分ごとに確認されます）" : "アプリにログインしてください"}
        className="flex items-center gap-2 rounded-md bg-brand px-3.5 py-2 text-[12px] font-bold text-white transition hover:opacity-90 disabled:opacity-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-2.6-6.3" />
          <path d="M21 3v6h-6" />
        </svg>
        取得を依頼
        {openRequests ? <span className="rounded bg-white/25 px-1.5 text-[10px]">{openRequests}件処理待ち</span> : null}
      </button>
      <AuthButton />
    </header>
  );
}
