import { useMemo, useRef, useState } from "react";
import type { DashboardData, DeviceKey } from "../types";
import { DEVICE_LABEL } from "./TabelogDetails";

const W = 800;
const H = 220;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 26;

export default function TrafficChart({
  series,
  deviceDaily,
}: {
  series: DashboardData["series"];
  deviceDaily?: Record<string, Record<DeviceKey, number | null>>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    if (series.length < 2) return null;
    const maxPv = Math.max(...series.map((s) => s.pv), 1);
    const step = (W - PAD_L - PAD_R) / (series.length - 1);
    const x = (i: number) => PAD_L + step * i;
    const yPv = (v: number) => PAD_T + (1 - v / maxPv) * (H - PAD_T - PAD_B);
    const pvPath = series
      .map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yPv(s.pv).toFixed(1)}`)
      .join(" ");
    return {
      step,
      x,
      maxPv,
      pvPath,
      areaPath: pvPath + ` L${x(series.length - 1).toFixed(1)},${H - PAD_B} L${PAD_L},${H - PAD_B} Z`,
      yPv,
    };
  }, [series]);

  if (!geom) return <div className="p-6 text-[12px] font-semibold text-faint">データがありません</div>;

  const gridValues = [0, 0.25, 0.5, 0.75, 1];
  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round((relX - PAD_L) / geom.step);
    setHover(Math.max(0, Math.min(series.length - 1, idx)));
  };

  const hv = hover != null ? series[hover] : null;
  const hvDevices = hv ? deviceDaily?.[hv.date] : undefined;
  const deviceText = hvDevices
    ? (["app", "pc", "sp"] as const)
        .filter((key) => hvDevices[key] != null)
        .map((key) => `${DEVICE_LABEL[key]} ${hvDevices[key]!.toLocaleString("ja-JP")}`)
        .join(" / ")
    : "";

  return (
    <div>
      <div className="mb-2 flex items-center gap-4">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-subtle">
          <span className="h-0.5 w-4 rounded bg-brand" />ページビュー
        </span>
        {hv ? (
          <span className="ml-auto rounded border border-line bg-card px-2 py-1 text-[10px] font-bold text-ink">
            {hv.date} · PV {hv.pv.toLocaleString("ja-JP")}
            {deviceText ? `（${deviceText}）` : ""}
          </span>
        ) : null}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair select-none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {gridValues.map((g) => {
          const y = PAD_T + (1 - g) * (H - PAD_T - PAD_B);
          return (
            <g key={g}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke="#eef1f5" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#98a2b3" fontWeight={600}>
                {Math.round(geom.maxPv * g).toLocaleString("ja-JP")}
              </text>
            </g>
          );
        })}
        <path d={geom.areaPath} fill="#2563eb" opacity={0.07} />
        <path d={geom.pvPath} fill="none" stroke="#2563eb" strokeWidth={2} />
        {[0, Math.floor(series.length / 2), series.length - 1].map((i) => (
          <text
            key={i}
            x={geom.x(i)}
            y={H - 8}
            textAnchor="middle"
            fontSize={9}
            fill="#98a2b3"
            fontWeight={600}
          >
            {series[i].date.slice(5)}
          </text>
        ))}
        {hover != null ? (
          <g>
            <line
              x1={geom.x(hover)}
              x2={geom.x(hover)}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke="#cbd5e1"
              strokeWidth={1}
            />
            <circle cx={geom.x(hover)} cy={geom.yPv(series[hover].pv)} r={3.2} fill="#2563eb" />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
