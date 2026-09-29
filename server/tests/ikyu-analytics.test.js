import test from "node:test";
import assert from "node:assert/strict";
import { dailyFor, monthsFor, periodComparison, weekdayPattern, reviewStats, pct, rate } from "../../src/lib/ikyu-analytics.ts";

const d = (storeId, date, pv, extra = {}) => ({ storeId, date, guideSp: null, guidePc: null, guide: pv - 1, planSp: null, planPc: null, plan: 1, otherSp: null, otherPc: null, other: 0, sp: null, pc: null, pv, reservations: 0, amount: 0, ...extra });
const month = (m, n, pv, storeId = "100001") => Array.from({ length: n }, (_, i) => d(storeId, `${m}-${String(i + 1).padStart(2, "0")}`, pv));

test("all-store totals add stores per day; unknown values stay null", () => {
  const rows = dailyFor([d("100001", "2026-09-01", 10), d("100002", "2026-09-01", 5, { sp: 3 }), d("100001", "2026-09-02", 7)], "all");
  assert.deepEqual(rows.map((r) => [r.date, r.pv, r.stores]), [["2026-09-01", 15, 2], ["2026-09-02", 7, 1]]);
  assert.equal(rows[0].sp, 3); assert.equal(rows[1].sp, null);
  assert.equal(dailyFor(rows.map((r) => ({ ...r, storeId: "x" })), "100001").length, 0);
});

test("month-to-date is compared with the same days of last month and last year", () => {
  const days = dailyFor([...month("2025-09", 30, 5), ...month("2026-08", 31, 8), ...month("2026-09", 28, 10)], "all");
  const p = periodComparison(days);
  assert.equal(p.to, "2026-09-28"); assert.equal(p.current.pv, 280);
  assert.equal(p.prevMonth.pv, 224); assert.equal(p.prevYear.pv, 140);
  assert.equal(pct(p.current.pv, p.prevMonth.pv), 25);
  // 前年の日が欠けていれば比較しない（0として扱わない）
  const gap = periodComparison(dailyFor([...month("2025-09", 10, 5), ...month("2026-09", 28, 10)], "all"));
  assert.equal(gap.prevYear, null); assert.equal(gap.prevMonth, null);
  assert.equal(rate(1, 0), null); assert.equal(rate(2, 200), 0.01);
});

test("weekday pattern averages the last 13 weeks and monthly rows merge completeness", () => {
  const w = weekdayPattern(dailyFor(month("2026-09", 28, 10), "all"));
  assert.equal(w.length, 7); assert.equal(w[2].label, "火"); assert.equal(w[2].pv, 10); assert.equal(w[2].days, 4);
  const m = monthsFor([{ ...d("100001", "", 10), month: "2026-08", complete: true, days: 31 }, { ...d("100002", "", 5), month: "2026-08", complete: false, days: 30 }], "all");
  assert.equal(m[0].pv, 15); assert.equal(m[0].complete, false);
});

test("review stats: overall average, category averages, quarterly trend and 要返信 list", () => {
  const r = (id, storeId, rating, needsReply, date, scores) => ({ id, source: "ikyu", rating, text: "", author: "a", sentiment: "neutral", date, details: { storeId, needsReply, postedAt: date, scores } });
  const reviews = [
    r("1", "100001", 5, true, "2026-09-22", [{ label: "総合", value: 5 }, { label: "料理・味", value: 5 }]),
    r("2", "100001", 4, false, "2026-07-01", [{ label: "料理・味", value: 4 }]),
    r("3", "100002", 2, true, "2026-01-10", [{ label: "料理・味", value: 1 }]),
    { id: "t", source: "tabelog", rating: 1, text: "", author: "", sentiment: "neutral", date: "2026-09-01" },
  ];
  const all = reviewStats(reviews, "all");
  assert.equal(all.count, 3); assert.equal(all.average, 3.67);
  assert.deepEqual(all.categories, [{ label: "料理・味", average: 3.33, count: 3 }]);
  assert.deepEqual(all.trend.map((t) => t.quarter), ["2026Q1", "2026Q3"]);
  assert.deepEqual(all.needsReply.map((x) => x.id), ["1", "3"]);
  assert.equal(reviewStats(reviews, "100002").needsReply.length, 1);
});
