import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIkyuIngest, ikyuReviewRow, checkPvRow } from "../../supabase/functions/_shared/ikyu-data.js";
import { buildIkyuDemo, buildSeed } from "../../supabase/functions/_shared/seed.js";

const day = (date, pv = 10) => ({ date, guideSp: pv - 4, guidePc: 2, guide: pv - 2, planSp: 1, planPc: 1, plan: 2, otherSp: 0, otherPc: 0, other: 0, sp: pv - 3, pc: 3, pv, reservations: 0, amount: 0 });
const monthDays = (month, n) => Array.from({ length: n }, (_, i) => day(`${month}-${String(i + 1).padStart(2, "0")}`));
const payload = (over = {}) => ({
  schemaVersion: 1, runId: "run-2026-09-29T09:00", agent: "grok-bot", capturedAt: "2026-09-29T09:00:00+09:00",
  stores: [{
    storeId: "112789", name: "ビストロ サヴァサヴァ",
    pageviews: { months: [{ month: "2026-08", days: monthDays("2026-08", 31) }, { month: "2026-09", days: monthDays("2026-09", 30) }] },
    reviews: { total: 1, items: [{ reservationNo: "26092000", postedAt: "2026-09-22", rating: 4.5, scores: [{ label: "料理・味", value: 5 }], text: "美味しかった", processing: "未返信 ／ 未処理", listUrl: "https://evil.example/" }] },
  }],
  ...over,
});

test("today and later are not stored; complete months are decided by the server", () => {
  const n = normalizeIkyuIngest(payload(), "2026-09-29");
  const s = n.stores[0];
  assert.equal(s.days.filter((d) => d.date.startsWith("2026-09")).length, 28);
  assert.equal(n.skippedDays, 2);
  assert.deepEqual(s.months.map((m) => [m.month, m.complete, m.days]), [["2026-08", true, 31], ["2026-09", false, 28]]);
  assert.equal(s.months[0].pv, 310);
  assert.equal(n.run.status, "ok");
  assert.match(n.run.message, /当日以降の2日分/);
  const r = s.reviews[0];
  assert.equal(r.needs_reply, true); assert.equal(r.rating, 4.5);
  assert.ok(!("listUrl" in r) && !JSON.stringify(n).includes("evil.example"));
  assert.equal(normalizeIkyuIngest(payload({ warning: "口コミ2ページ目は未取得" }), "2026-09-29").run.status, "partial");
});

test("malformed or inconsistent batches are rejected before any write", () => {
  const bad = (mutate, re) => { const p = payload(); mutate(p); assert.throws(() => normalizeIkyuIngest(p, "2026-09-29"), re); };
  bad((p) => { p.schemaVersion = 2; }, /schemaVersion/);
  bad((p) => { p.runId = "has space"; }, /runId/);
  bad((p) => { p.stores[0].storeId = "12345"; }, /storeId/);
  bad((p) => { p.stores.push({ ...p.stores[0] }); }, /重複/);
  bad((p) => { p.stores[0].pageviews.months[0].days[0].guide = 99; }, /一致しません/);
  bad((p) => { p.stores[0].pageviews.months[0].days[0].pv = -1; }, /数値/);
  bad((p) => { p.stores[0].pageviews.months[0].days[1].date = "2026-09-01"; }, /date/);
  bad((p) => { p.stores[0].pageviews.months.push({ month: "2026-12", days: [] }); }, /month/);
  bad((p) => { p.stores[0].reviews.items[0].rating = 6; }, /点数/);
  bad((p) => { p.stores[0].reviews.items.push({ ...p.stores[0].reviews.items[0] }); }, /reservationNo/);
  bad((p) => { p.stores[0].reviews.items[0].postedAt = "2026/09/22"; }, /日付/);
  bad((p) => { p.stores = [{ storeId: "112789", pageviews: { months: [{ month: "2026-09", days: [day("2026-09-29")] }] } }]; }, /保存できるデータ/);
  assert.throws(() => checkPvRow({ ...day("2026-09-01"), sp: 1 }, "x"), /スマホ・PC/);
});

test("a replied review and a missing reply field are derived consistently", () => {
  const p = payload();
  p.stores[0].reviews.items.push({ reservationNo: "A-2", text: "", reply: { text: "ありがとうございました", date: "2026-09-25" } }, { reservationNo: "A-3", processing: "返信済" });
  const [, replied, processed] = normalizeIkyuIngest(p, "2026-09-29").stores[0].reviews;
  assert.equal(replied.needs_reply, false); assert.equal(replied.reply_date, "2026-09-25");
  assert.equal(processed.needs_reply, false);
});

test("stored ikyu reviews link only to the official list page for their own store", () => {
  const row = ikyuReviewRow({ store_id: "112789", reservation_no: "26092000", rating: "4.50", scores: [{ label: "料理・味", value: 5 }], needs_reply: true, posted_at: "2026-09-22", text: "x" }, "店");
  assert.equal(row.rating, 4.5);
  assert.equal(row.details.listUrl, "https://restaurant.ikyu.com/rsOwner/v2/112789/legacy?path=/scriptO/rsOwnImpressions.asp");
  assert.equal(row.details.needsReply, true); assert.equal(row.source, "ikyu");
  assert.throws(() => ikyuReviewRow({ store_id: "../x", reservation_no: "1" }), /店舗ID/);
});

test("demo data is internally consistent with the ingest contract", () => {
  const demo = buildIkyuDemo(new Date("2026-09-29T00:00:00Z"));
  assert.equal(demo.stores.length, 2);
  for (const d of demo.daily) checkPvRow(d, d.date);
  assert.ok(demo.daily.every((d) => d.date < "2026-09-29"));
  assert.ok(demo.reviews.some((r) => r.details.needsReply) && demo.reviews.some((r) => !r.details.needsReply));
  assert.ok(buildSeed().reviews.filter((r) => r.source === "ikyu").every((r) => r.details?.origin === "ikyu_owner"));
});
