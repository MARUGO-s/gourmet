import { useMemo, useState } from "react";
import type { IkyuDetails as Details, IkyuPv, Review } from "../types";
import {
  ALL_STORES, dailyFor, monthsFor, pct, periodComparison, rate, reviewStats, shiftMonth, weekdayPattern,
} from "../lib/ikyu-analytics";

type Available = Exclude<Details, { unavailable: true }>;
const num = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : n.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const yen = (n: number | null | undefined) => (n == null ? "—" : `¥${Math.round(n).toLocaleString("ja-JP")}`);
const percent = (r: number | null, digits = 1) => (r == null ? "—" : `${(r * 100).toFixed(digits)}%`);
const monthLabel = (m: string) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }) : "—");

const C = { sp: "#2563eb", pc: "#93b4f5", guide: "#8A7340", plan: "#d4b46a", other: "#cbd5e1", res: "#12b76a" };

function Panel({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
        <h2 className="text-[13px] font-bold tracking-tight">{title}</h2>
        {badge ? <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{badge}</span> : null}
      </header>
      {children}
    </section>
  );
}
function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2.5 text-[10px] font-bold whitespace-nowrap text-faint ${right ? "text-right" : ""}`}>{children}</th>;
}
function Change({ value, label }: { value: number | null; label: string }) {
  if (value == null) return <span className="text-[10px] text-faint">{label} 比較データなし</span>;
  const cls = value > 0 ? "bg-ok-soft text-ok" : value < 0 ? "bg-danger-soft text-danger" : "text-faint";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${cls}`}>{label} {value > 0 ? "+" : ""}{value.toFixed(1)}%</span>;
}
function Card({ label, value, unit, sub, children }: { label: string; value: string; unit?: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <div className="text-[11px] font-bold tracking-wide text-faint">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-[22px] leading-none font-bold tracking-tight">{value}</span>
        {unit && value !== "—" ? <span className="text-[11px] font-bold text-faint">{unit}</span> : null}
      </div>
      {sub ? <p className="mt-1 text-[10px] font-semibold text-subtle">{sub}</p> : null}
      {children ? <div className="mt-2 flex flex-wrap gap-1.5">{children}</div> : null}
    </div>
  );
}

// ---------- 日別PV（積み上げ棒）+ 予約件数 ----------
type DayRow = IkyuPv & { date: string };
function TrendChart({ days }: { days: DayRow[] }) {
  const [mode, setMode] = useState<"device" | "page">("device");
  const [hover, setHover] = useState<number | null>(null);
  const series = days.slice(-60);
  const W = 800, H = 230, L = 40, R = 10, T = 12, B = 26;
  const stacks = (d: DayRow) => mode === "device"
    ? [{ key: "sp", label: "スマホ", value: d.sp, color: C.sp }, { key: "pc", label: "PC", value: d.pc, color: C.pc }]
    : [{ key: "guide", label: "店舗ガイド", value: d.guide, color: C.guide }, { key: "plan", label: "プラン詳細", value: d.plan, color: C.plan }, { key: "other", label: "その他", value: d.other, color: C.other }];
  if (!series.length) return <p className="p-6 text-[12px] font-semibold text-faint">日別PVはまだ取り込まれていません</p>;
  const max = Math.max(1, ...series.map((d) => d.pv ?? 0));
  const step = (W - L - R) / series.length;
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const hv = hover != null ? series[hover] : null;
  return (
    <div className="p-5">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-line p-0.5">
          {(["device", "page"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded px-2.5 py-1 text-[11px] font-bold ${mode === m ? "bg-brand-soft text-brand" : "text-subtle"}`}>
              {m === "device" ? "端末別" : "ページ別"}
            </button>
          ))}
        </div>
        {stacks(series[0]).map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1 text-[10px] font-bold text-subtle"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}</span>
        ))}
        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-subtle"><span className="h-2 w-2 rounded-full" style={{ background: C.res }} />予約件数</span>
        {hv ? (
          <span className="ml-auto rounded border border-line px-2 py-1 text-[10px] font-bold">
            {hv.date} · PV {num(hv.pv)}（{stacks(hv).map((s) => `${s.label} ${num(s.value)}`).join(" / ")}）· 予約 {num(hv.reservations)}件 {hv.amount ? yen(hv.amount) : ""}
          </span>
        ) : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor((((e.clientX - r.left) / r.width) * W - L) / step); setHover(i >= 0 && i < series.length ? i : null); }}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(max * g)} y2={y(max * g)} stroke="#eef1f5" />
            <text x={L - 6} y={y(max * g) + 3} textAnchor="end" fontSize={9} fill="#98a2b3" fontWeight={600}>{Math.round(max * g)}</text>
          </g>
        ))}
        {series.map((d, i) => {
          let base = 0;
          const x = L + i * step + step * 0.12;
          const w = Math.max(1, step * 0.76);
          return (
            <g key={d.date} opacity={hover == null || hover === i ? 1 : 0.55}>
              {d.pv == null ? <rect x={x} y={H - B - 2} width={w} height={2} fill="#f79009" /> : stacks(d).map((s) => {
                const v = s.value ?? 0; const top = y(base + v); const h = y(base) - top; base += v;
                return <rect key={s.key} x={x} y={top} width={w} height={Math.max(0, h)} fill={s.color} />;
              })}
              {d.reservations ? <circle cx={x + w / 2} cy={y(d.pv ?? 0) - 6} r={Math.min(6, 2.5 + d.reservations)} fill={C.res} /> : null}
            </g>
          );
        })}
        {[0, Math.floor(series.length / 2), series.length - 1].map((i) => (
          <text key={i} x={L + i * step + step / 2} y={H - 8} textAnchor="middle" fontSize={9} fill="#98a2b3" fontWeight={600}>{series[i].date.slice(5)}</text>
        ))}
      </svg>
      <p className="mt-1 text-[10px] text-faint">PVはページの表示回数です（ユニーク数ではありません）。橙の線は未掲載の日です（0PVとして描きません）。直近60日。</p>
    </div>
  );
}

function Bars({ rows, value, format, color, labelWidth = 28 }: { rows: { label: string; days?: number }[]; value: (i: number) => number | null; format: (n: number | null) => string; color: string; labelWidth?: number }) {
  const max = Math.max(1e-9, ...rows.map((_, i) => value(i) ?? 0));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={r.label} className="grid items-center gap-2 text-[11px]" style={{ gridTemplateColumns: `${labelWidth}px 1fr 56px` }}>
          <span className="truncate font-bold text-subtle" title={r.label}>{r.label}</span>
          <div className="h-2 rounded bg-surface"><div className="h-2 rounded" style={{ width: `${((value(i) ?? 0) / max) * 100}%`, background: color }} /></div>
          <span className="text-right font-bold">{format(value(i))}</span>
        </div>
      ))}
    </div>
  );
}

export default function IkyuDetails({ ikyu, reviews }: { ikyu: Details; reviews: Review[] }) {
  const [store, setStore] = useState<string>(ALL_STORES);
  const data = ikyu.unavailable ? null : (ikyu as Available);
  const days = useMemo(() => (data ? dailyFor(data.daily, store) : []), [data, store]);
  const months = useMemo(() => (data ? monthsFor(data.months, store) : []), [data, store]);
  const period = useMemo(() => periodComparison(days), [days]);
  const weekdays = useMemo(() => weekdayPattern(days), [days]);
  const stats = useMemo(() => reviewStats(reviews, store), [reviews, store]);
  const perStore = useMemo(() => (data ? data.stores.map((s) => {
    const p = periodComparison(dailyFor(data.daily, s.storeId));
    const r = reviewStats(reviews, s.storeId);
    return { store: s, period: p, reviews: r };
  }) : []), [data, reviews]);

  if (!data) {
    return (
      <section className="rounded-md border border-line bg-warn-soft px-5 py-4 text-[12px] font-semibold text-warn">
        一休の取り込みデータを表示するには、データベースに表を追加する必要があります（supabase/migrations/010_ikyu_ingest_and_store_credentials.sql と 011_external_agent_ingest_and_requests.sql）。
      </section>
    );
  }
  const storeName = (id: string) => { const s = data.stores.find((x) => x.storeId === id); return s?.name || s?.label || `店舗 ${id}`; };
  const lastRun = data.runs[0] ?? null;
  const cur = period?.current;
  const monthByKey = new Map(months.map((m) => [m.month, m]));
  // 公開ページの総合評価（店舗選択時はその店舗、全店舗は平均）。PR #11 で取り込んだ値は snapshots 側（KPI）に残っている。
  const publicStores = data.stores.filter((s) => (store === ALL_STORES || s.storeId === store) && s.publicRating != null);
  const publicRating = publicStores.length ? publicStores.reduce((a, s) => a + (s.publicRating ?? 0), 0) / publicStores.length : null;
  const publicCount = publicStores.length ? publicStores.reduce((a, s) => a + (s.publicReviewCount ?? 0), 0) : null;
  const publicAt = publicStores.map((s) => s.publicUpdatedAt).filter(Boolean).sort().at(-1) ?? null;
  const listUrl = store !== ALL_STORES ? `https://restaurant.ikyu.com/rsOwner/v2/${store}/legacy?path=/scriptO/rsOwnImpressions.asp` : null;

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-md border border-line bg-card p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h2 className="text-[13px] font-bold">一休.comレストラン 詳細分析 {data.demo ? <span className="ml-1 rounded bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn">デモ</span> : null}</h2>
            <p className="mt-1 text-[11px] text-subtle">データはGrok Botが一休の店舗管理画面と公開ページから取り込みます（アプリからは取得しません）。最終取り込み：{when(lastRun?.receivedAt)}{lastRun?.status === "partial" ? "（一部取得）" : ""}</p>
            <p className="mt-1 text-[11px] text-subtle">公開ページの評価：{publicRating == null ? "未取り込み" : `${publicRating.toFixed(2)}（口コミ ${num(publicCount)}件・${when(publicAt)}）`}</p>
            {lastRun?.message ? <p className="mt-1 text-[10px] text-warn">{lastRun.message}</p> : null}
          </div>
          <label className="ml-auto flex items-center gap-2 text-[11px] font-bold text-subtle">
            店舗
            <select value={store} onChange={(e) => setStore(e.target.value)} className="rounded-md border border-line bg-card px-2 py-1.5 text-[12px] font-semibold">
              <option value={ALL_STORES}>全店舗合計（{data.stores.length}店舗）</option>
              {data.stores.map((s) => <option key={s.storeId} value={s.storeId}>{storeName(s.storeId)}（{s.storeId}）</option>)}
            </select>
          </label>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <Card label={period ? `PV（${Number(period.month.slice(5))}/1〜${period.to.slice(5).replace("-", "/")}）` : "PV（今月）"} value={num(cur?.pv)} unit="PV"
          sub={cur ? `スマホ ${percent(rate(cur.sp, cur.pv), 0)} ・ PC ${percent(rate(cur.pc, cur.pv), 0)}` : undefined}>
          <Change value={pct(cur?.pv, period?.prevMonth?.pv)} label="前月同期" />
          <Change value={pct(cur?.pv, period?.prevYear?.pv)} label="前年同期" />
        </Card>
        <Card label="予約件数（同期間）" value={num(cur?.reservations)} unit="件" sub={cur?.amount != null ? `予約金額 ${yen(cur.amount)}` : undefined}>
          <Change value={pct(cur?.reservations, period?.prevMonth?.reservations)} label="前月同期" />
          <Change value={pct(cur?.reservations, period?.prevYear?.reservations)} label="前年同期" />
        </Card>
        <Card label="PV→予約 転換率" value={percent(rate(cur?.reservations, cur?.pv), 2)} sub={`前月同期 ${percent(rate(period?.prevMonth?.reservations, period?.prevMonth?.pv), 2)}`} />
        <Card label="プラン詳細への遷移率" value={percent(rate(cur?.plan, cur?.guide))} sub="プラン詳細PV ÷ 店舗ガイドPV" />
        <Card label="口コミ平均（総合）" value={num(stats.average, 2)} unit="pt" sub={`${stats.count}件の個別評価から算出（公式の店舗評価ではありません）`} />
        <Card label="要返信の口コミ" value={num(stats.needsReply.length)} unit="件" sub={stats.needsReply.length ? "下の一覧から一休の返信画面を開けます" : "未返信はありません"} />
      </div>

      <Panel title="日別PVの推移（一休）" badge={days.length ? `${days[0].date}〜${days.at(-1)!.date}` : undefined}>
        <TrendChart days={days} />
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="曜日別の平均（直近13週）">
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <div><p className="mb-2 text-[11px] font-bold">1日あたりPV</p><Bars rows={weekdays} value={(i) => weekdays[i].pv} format={(n) => num(n, 1)} color={C.sp} /></div>
            <div><p className="mb-2 text-[11px] font-bold">1日あたり予約件数</p><Bars rows={weekdays} value={(i) => weekdays[i].reservations} format={(n) => num(n, 2)} color={C.res} /></div>
          </div>
        </Panel>
        <Panel title="集客ファネル（今月の同期間）">
          <div className="flex flex-col gap-3 p-5 text-[12px]">
            {[
              { label: "店舗ガイドPV", value: cur?.guide ?? null, note: "" },
              { label: "プラン詳細PV", value: cur?.plan ?? null, note: `遷移率 ${percent(rate(cur?.plan, cur?.guide))}` },
              { label: "予約件数", value: cur?.reservations ?? null, note: `プラン詳細PVあたり ${percent(rate(cur?.reservations, cur?.plan), 2)}` },
            ].map((f, i, arr) => (
              <div key={f.label}>
                <div className="flex items-baseline justify-between"><span className="font-bold text-subtle">{f.label}</span><span className="font-bold">{num(f.value)}<span className="ml-2 text-[10px] text-faint">{f.note}</span></span></div>
                <div className="mt-1 h-2 rounded bg-surface"><div className="h-2 rounded bg-brand" style={{ width: `${Math.max(2, ((f.value ?? 0) / Math.max(1, arr[0].value ?? 1)) * 100)}%` }} /></div>
              </div>
            ))}
            <p className="text-[10px] text-faint">その他ページのPV：{num(cur?.other)}。予約件数・金額は管理画面の「当日予約」（その日に受け付けた予約）の値です。</p>
          </div>
        </Panel>
      </div>

      <Panel title="月別レポート（一休）" badge={`${months.length}か月分`}>
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead><tr className="border-b border-line">
              <Th>月</Th><Th right>PV</Th><Th right>スマホ比率</Th><Th right>店舗ガイド</Th><Th right>プラン詳細</Th><Th right>その他</Th>
              <Th right>予約件数</Th><Th right>予約金額</Th><Th right>転換率</Th><Th right>PV前月比</Th><Th right>PV前年比</Th><Th>状態</Th>
            </tr></thead>
            <tbody>
              {[...months].reverse().map((m) => {
                const prev = monthByKey.get(shiftMonth(m.month, -1));
                const last = monthByKey.get(shiftMonth(m.month, -12));
                const cmp = (v: number | null) => v == null ? <span className="text-faint">—</span> : <span className={`font-bold ${v > 0 ? "text-ok" : v < 0 ? "text-danger" : "text-faint"}`}>{v > 0 ? "+" : ""}{v.toFixed(1)}%</span>;
                return (
                  <tr key={m.month} className="border-b border-line last:border-b-0 hover:bg-surface">
                    <td className="px-3 py-2 text-[11px] font-bold whitespace-nowrap text-subtle">{monthLabel(m.month)}</td>
                    <td className="px-3 py-2 text-right text-[12px] font-bold">{num(m.pv)}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{percent(rate(m.sp, m.pv), 0)}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{num(m.guide)}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{num(m.plan)}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{num(m.other)}</td>
                    <td className="px-3 py-2 text-right text-[12px] font-bold text-ok">{num(m.reservations)}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{yen(m.amount)}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{percent(rate(m.reservations, m.pv), 2)}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{m.complete && prev?.complete ? cmp(pct(m.pv, prev.pv)) : <span className="text-faint">—</span>}</td>
                    <td className="px-3 py-2 text-right text-[11px]">{m.complete && last?.complete ? cmp(pct(m.pv, last.pv)) : <span className="text-faint">—</span>}</td>
                    <td className="px-3 py-2 text-[10px] font-bold whitespace-nowrap">{m.complete ? <span className="text-ok">確定</span> : <span className="text-warn">集計中・一部</span>}</td>
                  </tr>
                );
              })}
              {!months.length ? <tr><td colSpan={12} className="px-4 py-6 text-center text-[12px] text-faint">月別データはまだ取り込まれていません</td></tr> : null}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-2.5 text-[10px] font-semibold text-faint">月合計は管理画面の合計行の値です。前月比・前年比は双方が確定した月だけ表示します（集計中の月は上の「前月同期・前年同期」を参照）。</p>
      </Panel>

      {data.stores.length > 1 ? (
        <Panel title="店舗別の比較（今月の同期間）" badge={`${data.stores.length}店舗`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead><tr className="border-b border-line">
                <Th>店舗</Th><Th right>PV</Th><Th right>前月同期比</Th><Th right>予約件数</Th><Th right>転換率</Th><Th right>口コミ平均</Th><Th right>公開評価</Th><Th right>要返信</Th><Th>PV取り込み</Th>
              </tr></thead>
              <tbody>
                {perStore.map(({ store: s, period: p, reviews: r }) => {
                  const change = pct(p?.current.pv, p?.prevMonth?.pv);
                  return (
                    <tr key={s.storeId} onClick={() => setStore(s.storeId)} className={`cursor-pointer border-b border-line last:border-b-0 hover:bg-surface ${store === s.storeId ? "bg-brand-soft" : ""}`}>
                      <td className="px-3 py-2 text-[12px] font-bold">{storeName(s.storeId)}<span className="ml-1 text-[10px] text-faint">{s.storeId}</span></td>
                      <td className="px-3 py-2 text-right text-[12px] font-bold">{num(p?.current.pv)}</td>
                      <td className={`px-3 py-2 text-right text-[11px] font-bold ${change == null ? "text-faint" : change >= 0 ? "text-ok" : "text-danger"}`}>{change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}</td>
                      <td className="px-3 py-2 text-right text-[12px] font-bold text-ok">{num(p?.current.reservations)}</td>
                      <td className="px-3 py-2 text-right text-[11px]">{percent(rate(p?.current.reservations, p?.current.pv), 2)}</td>
                      <td className="px-3 py-2 text-right text-[11px]">{num(r.average, 2)}</td>
                      <td className="px-3 py-2 text-right text-[11px]">{s.publicRating == null ? "—" : s.publicRating.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right text-[11px]">{r.needsReply.length ? <span className="rounded bg-danger-soft px-1.5 py-0.5 font-bold text-danger">{r.needsReply.length}件</span> : "0"}</td>
                      <td className="px-3 py-2 text-[10px] whitespace-nowrap text-faint">{when(s.pageviewsUpdatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="項目別の平均評価" badge={`${stats.count}件`}>
          <div className="p-5">
            {stats.categories.length ? <Bars rows={stats.categories.map((c) => ({ label: c.label }))} value={(i) => stats.categories[i].average} format={(n) => num(n, 2)} color={C.guide} labelWidth={120} /> : <p className="text-[11px] text-faint">個別評価はまだありません</p>}
            <p className="mt-3 text-[10px] text-faint">5点満点。口コミの個別評価の単純平均です。</p>
          </div>
        </Panel>
        <Panel title="評価の推移（四半期）">
          <div className="p-5">
            {stats.trend.length ? (
              <div className="flex h-[120px] items-end gap-1.5">
                {stats.trend.slice(-12).map((t) => (
                  <div key={t.quarter} className="flex flex-1 flex-col items-center gap-1" title={`${t.quarter}：平均 ${t.average.toFixed(2)}（${t.count}件）`}>
                    <span className="text-[9px] font-bold">{t.average.toFixed(2)}</span>
                    <div className="w-full rounded-t bg-brand" style={{ height: `${(t.average / 5) * 80}px` }} />
                    <span className="text-[8px] text-faint">{t.quarter.slice(2)}</span>
                  </div>
                ))}
              </div>
            ) : <p className="text-[11px] text-faint">評価はまだありません</p>}
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-subtle">{stats.distribution.map((d) => <span key={d.star}>★{d.star}：{d.count}件</span>)}</div>
          </div>
        </Panel>
        <Panel title="要返信の口コミ" badge={`${stats.needsReply.length}件`}>
          <ul className="max-h-[260px] divide-y divide-line overflow-auto">
            {stats.needsReply.map((r) => (
              <li key={r.id} className="px-5 py-2.5 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[9px] font-bold text-danger">要返信</span>
                  <span className="font-bold">{r.rating == null ? "—" : r.rating.toFixed(2)}</span>
                  <span className="text-faint">{r.details?.postedAt ?? r.date ?? ""}</span>
                  {store === ALL_STORES ? <span className="truncate text-faint">{storeName(r.details?.storeId ?? "")}</span> : null}
                  {r.details?.listUrl ? <a href={r.details.listUrl} target="_blank" rel="noopener noreferrer" className="ml-auto whitespace-nowrap font-bold text-brand underline">一休で返信 ↗</a> : null}
                </div>
                <p className="mt-1 line-clamp-2 text-subtle">{r.text || "本文なし"}</p>
                <p className="mt-0.5 text-[10px] text-faint">予約番号 {r.details?.reservationNo ?? "—"} ・ {r.author} ・ {r.details?.publication ?? ""} ・ {r.details?.processing ?? ""}</p>
              </li>
            ))}
            {!stats.needsReply.length ? <li className="px-5 py-6 text-center text-[11px] text-faint">要返信の口コミはありません</li> : null}
          </ul>
          {listUrl ? <p className="border-t border-line px-5 py-2 text-[10px]"><a href={listUrl} target="_blank" rel="noopener noreferrer" className="font-bold text-brand underline">一休のクチコミ確認・返信画面を開く ↗</a></p> : null}
        </Panel>
      </div>
    </div>
  );
}
