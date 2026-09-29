type Props = {
  view: "dashboard" | "requests" | "accounts";
  onView: (v: "dashboard" | "requests" | "accounts") => void;
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
  if (name === "requests") {
    return (
      <svg {...common}>
        <path d="M21 12a9 9 0 1 1-2.6-6.3" />
        <path d="M21 3v6h-6" />
        <path d="M12 8v4l3 2" />
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

const ITEMS: { id: Props["view"]; label: string }[] = [
  { id: "dashboard", label: "ダッシュボード" },
  { id: "requests", label: "取得依頼" },
  { id: "accounts", label: "アカウント管理" },
];

export default function Sidebar({ view, onView }: Props) {
  return (
    <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-card md:flex">
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand">
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
        </div>
      </div>

      <nav className="flex flex-col gap-1 border-t border-line px-3 py-4">
        {ITEMS.map((it) => {
          const active = view === it.id;
          return (
            <button
              key={it.id}
              onClick={() => onView(it.id)}
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
    </aside>
  );
}
