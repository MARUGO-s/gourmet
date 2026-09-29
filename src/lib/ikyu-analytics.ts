// 一休の取り込みデータの集計（純粋関数）。未掲載(null)は0として扱わない。
import type { IkyuDay, IkyuMonth, IkyuPv, Review } from "../types";

export const PV_FIELDS = ["guideSp", "guidePc", "guide", "planSp", "planPc", "plan", "otherSp", "otherPc", "other", "sp", "pc", "pv", "reservations", "amount"] as const;
export type PvField = (typeof PV_FIELDS)[number];
export const ALL_STORES = "all";

const DAY = 86_400_000;
export const shiftDate = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
export const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
};
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

export function emptyPv(): IkyuPv {
  return Object.fromEntries(PV_FIELDS.map((k) => [k, null])) as IkyuPv;
}
// 値のある行だけ足す（すべて未掲載なら null）
export function addPv(a: IkyuPv, b: IkyuPv): IkyuPv {
  const out = { ...a };
  for (const k of PV_FIELDS) if (b[k] != null) out[k] = (out[k] ?? 0) + (b[k] as number);
  return out;
}

// 店舗選択（または全店舗合計）で日付ごとに合算
export function dailyFor(daily: IkyuDay[], store: string): (IkyuPv & { date: string; stores: number })[] {
  const byDate = new Map<string, IkyuPv & { date: string; stores: number }>();
  for (const d of daily) {
    if (store !== ALL_STORES && d.storeId !== store) continue;
    const cur = byDate.get(d.date) ?? { ...emptyPv(), date: d.date, stores: 0 };
    byDate.set(d.date, { ...addPv(cur, d), date: d.date, stores: cur.stores + 1 });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function monthsFor(months: IkyuMonth[], store: string): (IkyuPv & { month: string; complete: boolean; stores: number })[] {
  const byMonth = new Map<string, IkyuPv & { month: string; complete: boolean; stores: number }>();
  for (const m of months) {
    if (store !== ALL_STORES && m.storeId !== store) continue;
    const cur = byMonth.get(m.month) ?? { ...emptyPv(), month: m.month, complete: true, stores: 0 };
    byMonth.set(m.month, { ...addPv(cur, m), month: m.month, complete: cur.complete && m.complete, stores: cur.stores + 1 });
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export const pct = (now: number | null | undefined, prev: number | null | undefined) =>
  now == null || prev == null || prev === 0 ? null : Math.round(((now - prev) / prev) * 1000) / 10;
export const rate = (part: number | null | undefined, whole: number | null | undefined) =>
  part == null || whole == null || whole === 0 ? null : part / whole;

// 当月の1日〜最新日と、前月・前年同月の同じ日数を比較（前月末が短い場合は月末まで）。
// 比較期間の日が1日でも欠けていれば比較なし（未取得を0PVとして比べない）。
export function periodComparison(days: (IkyuPv & { date: string })[]) {
  const latest = days.at(-1)?.date;
  if (!latest) return null;
  const month = latest.slice(0, 7);
  const dayNo = Number(latest.slice(8, 10));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const range = (m: string) => {
    const end = Math.min(dayNo, daysIn(m));
    const rows = Array.from({ length: end }, (_, i) => byDate.get(`${m}-${String(i + 1).padStart(2, "0")}`));
    return rows.every(Boolean) ? rows.reduce((acc, r) => addPv(acc, r!), emptyPv()) : null;
  };
  return {
    month, from: `${month}-01`, to: latest, days: dayNo,
    current: range(month) ?? days.filter((d) => d.date.startsWith(month)).reduce((acc, r) => addPv(acc, r), emptyPv()),
    prevMonth: range(shiftMonth(month, -1)),
    prevYear: range(shiftMonth(month, -12)),
  };
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
// 直近 n 日の曜日別平均（PV・予約件数）
export function weekdayPattern(days: (IkyuPv & { date: string })[], n = 91) {
  const latest = days.at(-1)?.date;
  const from = latest ? shiftDate(latest, -(n - 1)) : "";
  const acc = WEEKDAYS.map((label) => ({ label, days: 0, pv: 0, reservations: 0, plan: 0 }));
  for (const d of days) {
    if (d.date < from || d.pv == null) continue;
    const w = acc[new Date(`${d.date}T00:00:00Z`).getUTCDay()];
    w.days++; w.pv += d.pv; w.reservations += d.reservations ?? 0; w.plan += d.plan ?? 0;
  }
  return acc.map((w) => ({ label: w.label, days: w.days, pv: w.days ? w.pv / w.days : null, plan: w.days ? w.plan / w.days : null, reservations: w.days ? w.reservations / w.days : null }));
}

export type IkyuReviewStats = ReturnType<typeof reviewStats>;
export function reviewStats(reviews: Review[], store: string) {
  const own = reviews.filter((r) => r.source === "ikyu" && (store === ALL_STORES || r.details?.storeId === store));
  const rated = own.filter((r) => r.rating != null);
  const avg = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null);
  const categories = new Map<string, number[]>();
  for (const r of own) for (const s of r.details?.scores ?? []) if (s.value != null && !/^総合/.test(s.label)) categories.set(s.label, [...(categories.get(s.label) ?? []), s.value]);
  const byQuarter = new Map<string, number[]>();
  for (const r of rated) {
    const date = r.details?.postedAt ?? r.date;
    if (!date) continue;
    const key = `${date.slice(0, 4)}Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
    byQuarter.set(key, [...(byQuarter.get(key) ?? []), r.rating!]);
  }
  const distribution = [5, 4, 3, 2, 1].map((star) => ({ star, count: rated.filter((r) => Math.round(r.rating!) === star).length }));
  const needsReply = own.filter((r) => r.details?.needsReply).sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return {
    count: own.length, average: avg(rated.map((r) => r.rating!)),
    categories: [...categories].map(([label, values]) => ({ label, average: avg(values)!, count: values.length })),
    trend: [...byQuarter].sort(([a], [b]) => a.localeCompare(b)).map(([quarter, values]) => ({ quarter, average: avg(values)!, count: values.length })),
    distribution, needsReply,
  };
}
