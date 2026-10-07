import { useEffect, useMemo, useState } from "react";
import { getOverview } from "../api";
import type { Overview, OverviewRow, OverviewSite, OverviewTotals, SourceMeta } from "../types";
import { sortOverviewRows } from "../../supabase/functions/_shared/stores.js";
import { formatTime } from "../lib/agent-requests";

type Props = { sources: SourceMeta[]; onSelectStore: (id: string) => void; onManage?: () => void };
type Metric = { id: keyof OverviewSite & keyof OverviewTotals; label: string; kind: "count" | "change" | "rating" | "time" };

const TOTAL_COLUMNS: Metric[] = [
  { id: "pv", label: "PV（月）", kind: "count" },
  { id: "prevPv", label: "前月PV", kind: "count" },
  { id: "pvChange", label: "前月比", kind: "change" },
  { id: "reservations", label: "予約", kind: "count" },
  { id: "rating", label: "評価", kind: "rating" },
  { id: "reviewCount", label: "口コミ数", kind: "count" },
  { id: "unreplied", label: "未返信", kind: "count" },
  { id: "lastUpdatedAt", label: "最終更新", kind: "time" },
];
const SITE_COLUMNS: Metric[] = TOTAL_COLUMNS.filter((c) => ["pv", "pvChange", "reservations", "rating", "reviewCount", "unreplied"].includes(c.id));
const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("ja-JP"));

function Cell({ metric, value }: { metric: Metric; value: OverviewSite | OverviewTotals | undefined }) {
  if (!value) return <td className="px-3 py-2 text-right text-faint">—</td>;
  const v = value[metric.id] as number | string | null;
  if (v == null) return <td className="px-3 py-2 text-right text-faint" title="未取得・比較データなし">—</td>;
  if (metric.kind === "rating") return <td className="px-3 py-2 text-right font-bold">{Number(v).toFixed(2)}</td>;
  if (metric.kind === "time") return <td className="px-3 py-2 text-right text-[10px] whitespace-nowrap text-faint">{formatTime(String(v))}</td>;
  if (metric.kind === "change") {
    const n = Number(v);
    const pct = value.pvChangePct;
    return (
      <td className={`px-3 py-2 text-right font-bold whitespace-nowrap ${n > 0 ? "text-ok" : n < 0 ? "text-danger" : "text-subtle"}`}>
        {n > 0 ? "+" : ""}{fmt(n)}{pct != null ? <span className="ml-1 text-[10px] font-semibold">（{pct > 0 ? "+" : ""}{pct.toFixed(2)}%）</span> : null}
      </td>
    );
  }
  return <td className={`px-3 py-2 text-right ${metric.id === "unreplied" && Number(v) > 0 ? "font-bold text-danger" : ""}`}>{fmt(Number(v))}</td>;
}

// 全店舗の比較（店舗×サイトの月別PV・前月比・予約・評価・口コミ数・未返信・最終更新）。店舗名を押すとその店舗へ切り替える。
export default function OverviewPage({ sources, onSelectStore, onManage }: Props) {
  const [month, setMonth] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bySite, setBySite] = useState(false);
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" }>({ column: "sortOrder", direction: "asc" });
  const names = new Map(sources.map((s) => [s.id, s]));

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getOverview(month || undefined)
      .then(({ overview }) => { if (alive) setData(overview); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "全店舗の比較を読み込めませんでした"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month]);

  const rows = useMemo(() => (data ? sortOverviewRows(data.stores, sort.column, sort.direction) : []), [data, sort]);
  const onSort = (column: string) => setSort((s) => (s.column === column ? { column, direction: s.direction === "asc" ? "desc" : "asc" } : { column, direction: column === "name" ? "asc" : "desc" }));
  const Th = ({ column, label, className = "" }: { column: string; label: string; className?: string }) => (
    <th className={`px-3 py-2 text-[10px] font-bold whitespace-nowrap text-faint ${className}`} aria-sort={sort.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button onClick={() => onSort(column)} className="hover:text-ink">{label}{sort.column === column ? (sort.direction === "asc" ? " ▲" : " ▼") : ""}</button>
    </th>
  );
  const siteIds = data?.sources ?? [];
  const cells = (r: { sites: Record<string, OverviewSite>; totals: OverviewTotals }) => (bySite
    ? siteIds.flatMap((id) => SITE_COLUMNS.map((c) => <Cell key={`${id}:${c.id}`} metric={c} value={r.sites[id]} />))
    : TOTAL_COLUMNS.map((c) => <Cell key={c.id} metric={c} value={r.totals} />));

  const row = (r: OverviewRow, unassigned = false) => (
    <tr key={r.id} className={`border-b border-line hover:bg-surface ${unassigned ? "bg-warn-soft" : ""}`}>
      <td className="sticky left-0 bg-card px-3 py-2 text-left">
        {unassigned ? (
          <span className="flex flex-col">
            <span className="font-bold text-warn">{r.name}</span>
            <span className="text-[10px] text-faint">
              {Object.entries(r.sites).map(([id, s]) => `${names.get(id)?.name ?? id} ${s.keys.map((k) => k.key || "既定").join("・")}`).join(" / ")}
            </span>
            {onManage && <button onClick={onManage} className="self-start text-[10px] font-bold text-brand underline">店舗管理で割り当てる</button>}
          </span>
        ) : (
          <button onClick={() => onSelectStore(r.id)} className="text-left font-bold text-brand hover:underline" title="この店舗の画面へ切り替えます">{r.name}</button>
        )}
      </td>
      {cells(r)}
    </tr>
  );

  return (
    <section className="rounded-md border border-line bg-card" aria-label="全店舗の比較">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <h2 className="text-[13px] font-bold tracking-tight">全店舗の比較</h2>
        {data ? <span className="text-[11px] text-subtle">{data.month}（前月 {data.prevMonth} と比較）</span> : null}
        <label className="ml-auto flex items-center gap-1.5 text-[11px] font-bold text-subtle">対象月
          <input type="month" value={month || data?.month || ""} onChange={(e) => setMonth(e.target.value)} className="rounded border border-line px-2 py-1 font-normal text-ink" />
        </label>
        <div className="flex overflow-hidden rounded border border-line text-[11px] font-bold">
          <button onClick={() => setBySite(false)} className={`px-2.5 py-1 ${!bySite ? "bg-brand text-white" : "text-subtle"}`}>店舗合計</button>
          <button onClick={() => setBySite(true)} className={`px-2.5 py-1 ${bySite ? "bg-brand text-white" : "text-subtle"}`}>サイト別</button>
        </div>
      </header>
      <p className="px-5 pt-3 text-[11px] leading-relaxed text-faint">
        PV・予約は対象月の月別の値（未取得は「—」、0とは区別）。前月比は前月の値もあるサイトだけで比較します。評価は各サイトの最新の店舗評価（店舗合計ではサイトの平均）、口コミ数はサイトの掲載数、未返信は要返信の口コミの件数です。どの店舗にも割り当てていないサイトの店舗IDのデータは「未割り当て」に表示します。
      </p>
      {error ? <p className="mx-5 mt-3 rounded bg-danger-soft px-3 py-2 text-[11px] font-bold text-danger">⚠ {error}</p> : null}
      {loading && !data ? (
        <p className="px-5 py-10 text-center text-[12px] font-semibold text-faint">読み込み中…</p>
      ) : data ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-[12px]">
            <thead>
              {bySite ? (
                <tr className="border-b border-line">
                  <th />
                  {siteIds.map((id) => (
                    <th key={id} colSpan={SITE_COLUMNS.length} className="border-l border-line px-3 py-1.5 text-center text-[11px] font-bold">
                      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: names.get(id)?.color ?? "#cbd5e1" }} />{names.get(id)?.name ?? id}</span>
                    </th>
                  ))}
                </tr>
              ) : null}
              <tr className="border-b border-line text-right">
                <Th column="name" label="店舗" className="sticky left-0 bg-card text-left" />
                {bySite
                  ? siteIds.flatMap((id) => SITE_COLUMNS.map((c) => <Th key={`${id}:${c.id}`} column={`${id}:${c.id}`} label={c.label} />))
                  : TOTAL_COLUMNS.map((c) => <Th key={c.id} column={c.id} label={c.label} />)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => row(r))}
              {data.unassigned ? row(data.unassigned, true) : null}
              {!rows.length && !data.unassigned ? (
                <tr><td colSpan={99} className="cell-wrap px-5 py-8 text-center text-faint">閲覧できる店舗がありません。{onManage && <button onClick={onManage} className="font-bold text-brand underline">店舗管理</button>}</td></tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line bg-surface font-bold">
                <td className="sticky left-0 bg-surface px-3 py-2 text-left">合計{data.unassigned ? <span className="ml-1 text-[10px] font-semibold text-faint">（未割り当てを含む）</span> : null}</td>
                {bySite
                  ? siteIds.flatMap((id) => SITE_COLUMNS.map((c) => <Cell key={`${id}:${c.id}`} metric={c} value={data.totals.sites[id]} />))
                  : TOTAL_COLUMNS.map((c) => <Cell key={c.id} metric={c} value={data.totals} />)}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </section>
  );
}
