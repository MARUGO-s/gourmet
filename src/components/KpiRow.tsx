import type { DashboardData } from "../types";

type Card = {
  label: string;
  unit?: string;
  value: number;
  delta: number;
  digits?: number;
  compare: string;
};

// すべてのサイトで評価は小数点第2位まで統一する。
function fmt(n: number, digits = 0) {
  return n.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function Delta({ delta, unit, digits = 0 }: { delta: number; unit?: string; digits?: number }) {
  if (delta === 0) {
    return <span className="text-[11px] font-semibold text-faint">±{fmt(0, digits)}</span>;
  }
  const up = delta > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-bold ${
        up ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"
      }`}
    >
      {up ? "▲" : "▼"} {fmt(Math.abs(delta), digits)}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

export default function KpiRow({ kpis }: { kpis: DashboardData["kpis"] }) {
  const month = kpis.reservations.month;
  const cards: Card[] = [
    { label: "平均評価", unit: "pt", value: kpis.rating.value, delta: kpis.rating.delta, digits: 2, compare: "前週比" },
    { label: "累計口コミ", unit: "件", value: kpis.reviews.value, delta: kpis.reviews.delta, compare: "前週比" },
    { label: "ページビュー（直近7日）", unit: "PV", value: kpis.pv.value, delta: kpis.pv.delta, compare: "前週比" },
    {
      label: month ? `ネット予約組数（${Number(month.slice(5))}月）` : "ネット予約組数（月間）",
      unit: "組",
      value: kpis.reservations.value,
      delta: kpis.reservations.delta,
      compare: "前月比",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-md border border-line bg-card p-4">
          <div className="text-[11px] font-bold tracking-wide text-faint">{c.label}</div>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className="text-[24px] leading-none font-bold tracking-tight">
              {fmt(c.value, c.digits ?? 0)}
            </span>
            {c.unit ? <span className="text-[11px] font-bold text-faint">{c.unit}</span> : null}
          </div>
          <div className="mt-2">
            <Delta delta={c.delta} unit={c.unit === "pt" ? "pt" : undefined} digits={c.digits ?? 0} />
            <span className="ml-1.5 text-[10px] font-semibold text-faint">{c.compare}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
