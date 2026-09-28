import type { DashboardData, Review, SourceMeta } from "../types";

const STAR_MAX = 5;

function Stars({ rating }: { rating: number }) {
  const shown = Math.round(rating);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[11px] leading-none text-warn">
        {"★".repeat(shown)}
        <span className="text-faint">{"★".repeat(Math.max(0, STAR_MAX - shown))}</span>
      </span>
      <span className="text-[11px] font-bold">{rating ? rating.toFixed(2) : "—"}</span>
    </span>
  );
}

const SENTIMENT: Record<Review["sentiment"], { label: string; cls: string }> = {
  positive: { label: "ポジティブ", cls: "bg-ok-soft text-ok" },
  neutral: { label: "通常", cls: "bg-surface text-subtle" },
  negative: { label: "ネガティブ", cls: "bg-danger-soft text-danger" },
};

export default function ReviewsTable({
  reviews,
  sources,
}: {
  reviews: DashboardData["reviews"];
  sources: SourceMeta[];
}) {
  const srcMap = new Map(sources.map((s) => [s.id, s]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left">
        <thead>
          <tr className="border-b border-line">
            {["日付", "サイト", "評価", "傾向", "口コミ内容"].map((h) => (
              <th key={h} className="px-4 py-2.5 text-[10px] font-bold tracking-wide text-faint uppercase">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reviews.map((r) => {
            const s = srcMap.get(r.source);
            const st = SENTIMENT[r.sentiment];
            return (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-surface">
                <td className="px-4 py-2.5 text-[11px] font-semibold whitespace-nowrap text-faint">
                  {r.date}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: s?.color ?? "#cbd5e1" }}
                    />
                    {s?.name ?? r.source}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <Stars rating={r.rating} />
                </td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${st.cls}`}>
                    {st.label}
                  </span>
                </td>
                <td className="max-w-[420px] truncate px-4 py-2.5 text-[11px] font-medium text-subtle">
                  {r.text}
                </td>
              </tr>
            );
          })}
          {reviews.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-[12px] font-semibold text-faint">
                口コミはありません
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
