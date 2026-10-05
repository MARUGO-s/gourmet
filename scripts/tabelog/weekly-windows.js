// 週報用の期間ヘルパー（サーバー算術。モデルに足し引きさせない）。

const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** asOf（日本時間の当日）より前の直近7日と、その直前7日 */
export function weeklyPvWindows(asOf) {
  if (!validDate(asOf)) throw new Error("asOf は YYYY-MM-DD です");
  const last7to = shiftDate(asOf, -1);
  const last7from = shiftDate(asOf, -7);
  const prior7to = shiftDate(asOf, -8);
  const prior7from = shiftDate(asOf, -14);
  return {
    asOf,
    last7: { from: last7from, to: last7to },
    prior7: { from: prior7from, to: prior7to },
    last30: { from: shiftDate(asOf, -30), to: last7to },
  };
}

export function sumDailyPv(rows, from, to) {
  const list = (rows ?? []).filter((r) => r?.date >= from && r.date <= to && r.pv != null);
  if (!list.length) return { pv: null, days: 0, missingDates: [] };
  const byDate = new Map();
  for (const r of list) byDate.set(r.date, (byDate.get(r.date) ?? 0) + Number(r.pv));
  let pv = 0;
  const missingDates = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    if (!byDate.has(d)) missingDates.push(d);
    else pv += byDate.get(d);
  }
  return { pv: missingDates.length ? null : pv, days: byDate.size, daysExpected: [...byDate.keys()].length + missingDates.length, missingDates, byDate: Object.fromEntries(byDate) };
}

export function pctChange(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function within30Days(openedOn, asOf) {
  if (!validDate(openedOn) || !validDate(asOf)) return false;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${openedOn}T00:00:00Z`);
  const days = (a - b) / 86400000;
  return days >= 0 && days <= 30;
}
