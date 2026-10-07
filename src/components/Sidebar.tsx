import { useEffect, useRef, type ReactNode } from "react";

type ViewId = "overview" | "dashboard" | "ai" | "requests" | "schedules" | "alerts" | "accounts" | "stores" | "users";
type Props = {
  // null = 店舗の選択画面
  view: ViewId | null;
  onView: (v: ViewId) => void;
  signedIn: boolean;
  isAdmin: boolean;
  canUseApp: boolean;
  // 表示中の店舗（'全店舗' / 店舗名）
  storeName: string | null;
  // スマートフォン幅のメニュー（ドロワー）の開閉
  mobileOpen?: boolean;
  onClose?: () => void;
  // 店舗の選択画面に戻る（ドロワー内の「店舗を選び直す」）
  onReselect?: () => void;
};

function NavIcon({ name }: { name: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (name === "overview") {
    return (
      <svg {...common}>
        <path d="M3 21h18" />
        <rect x="4" y="11" width="4" height="8" rx="1" />
        <rect x="10" y="6" width="4" height="13" rx="1" />
        <rect x="16" y="9" width="4" height="10" rx="1" />
      </svg>
    );
  }
  if (name === "stores") {
    return (
      <svg {...common}>
        <path d="M4 9.5 5.5 4h13L20 9.5" />
        <path d="M4 9.5c0 1.4 1.2 2.5 2.7 2.5s2.6-1.1 2.6-2.5c0 1.4 1.2 2.5 2.7 2.5s2.7-1.1 2.7-2.5c0 1.4 1.1 2.5 2.6 2.5S20 10.9 20 9.5" />
        <path d="M5.5 12v8h13v-8M10 20v-4.5h4V20" />
      </svg>
    );
  }
  if (name === "dashboard") {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="8" height="10" rx="1.5" />
        <rect x="13" y="3" width="8" height="6" rx="1.5" />
        <rect x="3" y="15" width="8" height="6" rx="1.5" />
        <rect x="13" y="11" width="8" height="10" rx="1.5" />
      </svg>
    );
  }
  if (name === "ai") {
    return (
      <svg {...common}>
        <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" />
        <path d="M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z" />
        <path d="M5 16.5l.6 1.4 1.4.6-1.4.6L5 20.5l-.6-1.4-1.4-.6 1.4-.6.6-1.4z" />
      </svg>
    );
  }
  if (name === "requests") {
    return (
      <svg {...common}>
        <path d="M21 12a9 9 0 1 1-2.6-6.3" />
        <path d="M21 3v6h-6" />
        <path d="M12 8v4l3 2" />
      </svg>
    );
  }
  if (name === "alerts") {
    return (
      <svg {...common}>
        <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z" />
        <path d="M10 20.5a2 2 0 0 0 4 0" />
      </svg>
    );
  }
  if (name === "schedules") {
    return (
      <svg {...common}>
        <rect x="3" y="4.5" width="18" height="16" rx="2" />
        <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
        <path d="M12 12.5v3l2 1.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
      <path d="M19.5 4.5v4M21.5 6.5h-4" />
    </svg>
  );
}

const ITEMS: { id: ViewId; label: string; signedIn?: boolean; adminOnly?: boolean }[] = [
  { id: "overview", label: "全店舗の比較", signedIn: true },
  { id: "dashboard", label: "ダッシュボード" },
  { id: "ai", label: "AI分析", signedIn: true, adminOnly: true },
  { id: "requests", label: "取得依頼", adminOnly: true },
  { id: "schedules", label: "自動取得の設定", adminOnly: true },
  { id: "alerts", label: "口コミ通知", signedIn: true, adminOnly: true },
  { id: "accounts", label: "アカウント管理", adminOnly: true },
  { id: "stores", label: "店舗管理", signedIn: true, adminOnly: true },
  { id: "users", label: "ユーザー管理", signedIn: true, adminOnly: true },
];

export default function Sidebar({ view, onView, signedIn, isAdmin, canUseApp, storeName, mobileOpen = false, onClose, onReselect }: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);

  // スマートフォン幅のメニュー（ドロワー）: 開いている間は背景のスクロールを止め、Escapeで閉じる
  useEffect(() => {
    if (!mobileOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
    // 画面幅が広がってデスクトップ表示になったら閉じる
    const mq = window.matchMedia("(min-width: 768px)");
    const onMq = () => { if (mq.matches) onClose?.(); };
    document.addEventListener("keydown", onKey);
    mq.addEventListener("change", onMq);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onMq);
      opener?.focus?.();
    };
  }, [mobileOpen, onClose]);

  const choose = (v: ViewId) => { onView(v); onClose?.(); };

  return (
    <>
      <aside className="no-print hidden w-[232px] shrink-0 flex-col border-r border-line bg-card md:flex">
        <SidebarContent view={view} onView={onView} signedIn={signedIn} isAdmin={isAdmin} canUseApp={canUseApp} storeName={storeName} />
      </aside>

      {/* スマートフォン幅: 左から開くメニュー（ドロワー）と暗い背景 */}
      <div className={`no-print mobile-nav fixed inset-0 z-40 md:hidden ${mobileOpen ? "" : "pointer-events-none"}`} aria-hidden={!mobileOpen} inert={!mobileOpen}>
        <div
          className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${mobileOpen ? "opacity-100" : "opacity-0"}`}
          onClick={onClose}
          data-testid="mobile-nav-backdrop"
        />
        <div
          id="mobile-nav"
          role="dialog"
          aria-modal="true"
          aria-label="メニュー"
          className={`absolute inset-y-0 left-0 flex w-[272px] max-w-[85vw] flex-col overflow-y-auto bg-card shadow-xl transition-transform duration-200 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
        >
          <SidebarContent
            view={view}
            onView={choose}
            signedIn={signedIn}
            isAdmin={isAdmin}
            canUseApp={canUseApp}
            storeName={storeName}
            onReselect={onReselect ? () => { onReselect(); onClose?.(); } : undefined}
            closeButton={
              <button
                ref={closeButton}
                type="button"
                onClick={onClose}
                aria-label="メニューを閉じる"
                title="閉じる"
                className="ml-auto flex h-9 w-9 items-center justify-center rounded-md text-subtle hover:bg-surface hover:text-ink"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            }
          />
        </div>
      </div>
    </>
  );
}

function SidebarContent({ view, onView, signedIn, isAdmin, canUseApp, storeName, onReselect, closeButton }: Pick<Props, "view" | "onView" | "signedIn" | "isAdmin" | "canUseApp" | "storeName" | "onReselect"> & { closeButton?: ReactNode }) {
  return (
    <>
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3l2.2 4.6 5.1.7-3.7 3.6.9 5-4.5-2.4-4.5 2.4.9-5L4.7 8.3l5.1-.7L12 3z"
                fill="#fff"
              />
            </svg>
          </div>
          <div>
            <div className="text-[13px] leading-tight font-bold tracking-tight">
              Review Command
            </div>
            <div className="text-[10px] leading-tight font-medium tracking-wide text-faint uppercase">
              口コミ・予約 統合管理
            </div>
          </div>
          {closeButton}
        </div>
      </div>

      {signedIn ? (
        <div className="border-t border-line px-5 py-3">
          <p className="mb-2 text-[11px] font-bold text-brand">{isAdmin ? "管理者" : canUseApp ? "閲覧ユーザー" : "閲覧不可"}</p>
          <div className="text-[10px] font-bold tracking-wide text-faint">表示中の店舗</div>
          <div className="mt-0.5 truncate text-[13px] font-bold text-brand" title={storeName ?? ""}>{storeName ?? "未選択"}</div>
          {onReselect ? (
            <button type="button" onClick={onReselect} className="mt-2 rounded-md border border-line px-2.5 py-1.5 text-[11px] font-bold text-subtle hover:text-ink">
              店舗を選び直す
            </button>
          ) : null}
        </div>
      ) : null}
      <nav className="flex flex-col gap-1 border-t border-line px-3 py-4" aria-label="メインメニュー">
        {ITEMS.filter((it) => canUseApp && (signedIn || !it.signedIn) && (!it.adminOnly || isAdmin)).map((it) => {
          const active = view === it.id;
          return (
            <button
              key={it.id}
              onClick={() => onView(it.id)}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-semibold transition ${
                active
                  ? "bg-brand-soft text-brand"
                  : "text-subtle hover:bg-surface hover:text-ink"
              }`}
            >
              <NavIcon name={it.id} />
              {it.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-line px-5 py-4">
        <div className="text-[10px] leading-relaxed font-medium text-faint">
          管理対象サイト（すべてGrok Botが取り込み）
          <br />
          食べログ / ホットペッパー / Google / トレタ / 一休 / Retty
        </div>
        <div className="mt-3 text-[10px] font-semibold text-faint">
          gourmet · Supabase連携版
        </div>
      </div>
    </>
  );
}
