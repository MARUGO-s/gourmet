import test from "node:test";
import assert from "node:assert/strict";
import { japanDate, mergeSnapshots, saveSyncResult, snapshotUpdates, validateTabelogResult, verifySnapshots } from "../sync-data.js";
import { toDailyPv, readConversionTable, buildRanking } from "../scraper.js";

const sample = () => ({
  data: { rating: 3.26, reviews: 49 },
  daily: [{ date: "2026-09-01", pv: 100, pc: 20, sp: 70, app: 10 }, { date: "2026-09-02", pv: 0, pc: 0, sp: 0, app: 0 }],
  monthly: [{ month: "2026-09", reservations: 4, pv: 100, pc: 20, sp: 70, app: 10 }],
  reviews: [{ text: "新しい口コミ", author: "test", rating: 4 }],
});

test("保存日はサーバーのタイムゾーンによらず日本時間", () => {
  assert.equal(japanDate(new Date("2026-09-28T15:10:00Z")), "2026-09-29");
});

test("月初のPV・月別予約・評価が同一行でも保持される", () => {
  const rows = snapshotUpdates("owner", "tabelog", sample(), "2026-09-01");
  assert.deepEqual(rows[0], { user_id: "owner", source: "tabelog", date: "2026-09-01", pv: 100, reservations: 4, rating: 3.26, reviews: 49 });
  assert.equal(new Set(rows.map((r) => r.date)).size, rows.length);
});

test("取得対象外の既存列を保持し、取得した0は保存する", () => {
  const rows = mergeSnapshots([{ date: "2026-09-02", pv: 0 }], [{ date: "2026-09-02", pv: 11, rating: 3.26, reservations: 4, reviews: 49, visits: 8 }]);
  assert.equal(rows[0].pv, 0);
  assert.equal(rows[0].rating, 3.26);
  assert.equal(rows[0].reservations, 4);
  assert.equal(rows[0].visits, 8);
});

test("欠落行と評価の丸めを保存失敗として検出", () => {
  const rows = mergeSnapshots(snapshotUpdates("owner", "tabelog", sample(), "2026-09-03"), []);
  assert.doesNotThrow(() => verifySnapshots(rows, rows.map((r) => ({ ...r, rating: r.rating == null ? null : String(r.rating) }))));
  assert.throws(() => verifySnapshots(rows, rows.slice(1)), /保存を確認/);
  assert.throws(() => verifySnapshots(rows, rows.map((r) => ({ ...r, rating: r.rating == null ? null : Math.round(r.rating * 10) / 10 }))), /小数点精度/);
});

test("正常値と0件・0PVを受け入れる", () => {
  assert.doesNotThrow(() => validateTabelogResult(sample()));
  const result = sample(); result.data.reviews = 0; result.monthly[0].reservations = 0;
  assert.doesNotThrow(() => validateTabelogResult(result));
});

test("日付・欠落・負数・重複・端末別合計の誤りを拒否", () => {
  const mutations = [
    (r) => { r.data.rating = NaN; },
    (r) => { r.data.reviews = -1; },
    (r) => { r.daily = []; },
    (r) => { r.daily[0].date = "2026-02-30"; },
    (r) => { r.daily[0].pc = 99; },
    (r) => { r.daily[0].pv = -1; },
    (r) => { r.daily.push(r.daily[0]); },
    (r) => { r.monthly[0].month = "2026-13"; },
    (r) => { r.monthly[0].reservations = -1; },
    (r) => { r.monthly[0].sp = 99; },
  ];
  for (const change of mutations) { const r = sample(); change(r); assert.throws(() => validateTabelogResult(r)); }
});

test("未取得の端末別項目は0と見なさずnullのまま許容", () => {
  const result = sample(); result.daily[0].pc = null;
  assert.doesNotThrow(() => validateTabelogResult(result));
});

test("確定日の末尾0PVを残し、当日の集計中データだけを除外", () => {
  const raw = [1, 2, 3].map((d) => ({ x: Date.parse(`2026-09-0${d}`), y: d === 1 ? 100 : 0 }));
  assert.deepEqual(toDailyPv(raw, {}, "2026-09-03").map((r) => [r.date, r.pv]), [["2026-09-01", 100], ["2026-09-02", 0]]);
});

// Supabaseの応答境界を再現し、実データベースを変更せず保存失敗・削除防止を検証する。
function mockClient({ existing = [], known = [], failSave = false, roundRating = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      let action = "select"; let payload;
      const query = {
        select() { return query; }, eq() { return query; }, in() { return query; },
        upsert(rows) { action = "upsert"; payload = rows; return query; },
        insert(rows) { action = "insert"; payload = rows; return query; },
        delete() { assert.fail("保存処理で既存行を削除してはいけない"); },
        then(resolve, reject) {
          calls.push({ table, action, payload });
          let response;
          if (table === "snapshots" && action === "select") response = { data: existing };
          else if (table === "snapshots" && failSave) response = { error: { message: "write failed" } };
          else if (table === "snapshots") response = { data: payload.map((r) => ({ ...r, rating: roundRating && r.rating != null ? Math.round(r.rating * 10) / 10 : r.rating })) };
          else response = { data: action === "select" ? known : payload };
          return Promise.resolve(response).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("保存後の件数と値を確認し、既存口コミを削除せず新規だけ追加", async () => {
  const client = mockClient({ known: [{ text: "過去の口コミ" }, { text: "既存" }] });
  const result = sample(); result.reviews.push({ text: "既存" }, result.reviews[0]);
  const summary = await saveSyncResult(client, "owner", "tabelog", result);
  assert.deepEqual(summary, { rating: 3.26, reviews: 49, dailyDays: 2, monthlyMonths: 1, latestPvDate: "2026-09-02" });
  const inserts = client.calls.filter((c) => c.table === "reviews" && c.action === "insert");
  assert.equal(inserts[0].payload.length, 1);
  assert.equal(inserts[0].payload[0].text, "新しい口コミ");
});

test("数値検証に失敗したらDBへの書き込みを開始しない", async () => {
  const client = mockClient(); const result = sample(); result.daily[0].pv = 900;
  await assert.rejects(saveSyncResult(client, "owner", "tabelog", result), /一致しません/);
  assert.equal(client.calls.length, 0);
});

test("書き込みエラー・DBの丸めを成功として返さない", async () => {
  await assert.rejects(saveSyncResult(mockClient({ failSave: true }), "owner", "tabelog", sample()), /write failed/);
  await assert.rejects(saveSyncResult(mockClient({ roundRating: true }), "owner", "tabelog", sample()), /小数点精度/);
});

test("2段見出しから予約組数とPV列を区別し、地図印刷をPVと混同しない", () => {
  const cell = (text, rowSpan = 1, colSpan = 1) => ({ textContent: text, rowSpan, colSpan });
  const rows = [
    { cells: [cell("年月", 2), cell("アクセス数", 1, 4), cell("インターネット予約組数", 2), cell("通話成立数", 2), cell("【PC】地図印刷ページへのアクセス数（PV）", 2)] },
    { cells: [cell("総合"), cell("PC"), cell("スマートフォン"), cell("アプリ")] },
    { cells: [cell("2026-08"), cell("1,000"), cell("100"), cell("800"), cell("100"), cell("24"), cell("5"), cell("3")] },
    { cells: [cell("2026-09"), cell("0"), cell("0"), cell("0"), cell("0"), cell("0"), cell("—"), cell("—")] },
  ];
  const original = globalThis.document;
  globalThis.document = { querySelector: () => ({ querySelectorAll: () => rows }) };
  try {
    const { months } = readConversionTable();
    assert.deepEqual(months[0], { month: "2026-08", reservations: 24, calls: 5, mapPrints: 3, pv: 1000, pc: 100, sp: 800, app: 100 });
    assert.equal(months[1].reservations, 0);
    assert.equal(months[1].calls, null);
  } finally { globalThis.document = original; }
});

test("自店名の全半角・空白差を吸収して順位を特定", () => {
  const result = buildRanking({ shopName: "テスト Ａ" }, { entries: [{ rank: 1, name: "他店" }, { rank: 139, name: "テストA" }] });
  assert.equal(result.self.rank, 139);
});

test('部分取得は未取得を0や当日の評価として保存しない', async()=>{
  const result=sample(); result.status='partial'; result.warning='評価・口コミ数は未取得'; result.data={rating:null,reviews:null};
  validateTabelogResult(result);
  const updates=snapshotUpdates('owner','tabelog',result,'2026-09-29');
  assert.ok(!updates.some(r=>r.date==='2026-09-29'));
  assert.ok(updates.every(r=>!('rating' in r) && !('reviews' in r)));
  const client=mockClient();
  const summary=await saveSyncResult(client,'owner','tabelog',result);
  assert.equal(summary.rating,null); assert.equal(summary.reviews,null);
  assert.ok(client.calls.find(c=>c.action==='upsert').payload.every(r=>r.rating===null));
});
test('一部取得でも既存の評価と口コミ数は保持する',async()=>{
  const result=sample(); result.status='partial';result.warning='評価未取得';result.data={rating:null,reviews:null};
  const client=mockClient({existing:[{date:'2026-09-01',rating:3.47,reviews:101,pv:11}]});
  await saveSyncResult(client,'owner','tabelog',result);
  const saved=client.calls.find(c=>c.action==='upsert').payload.find(r=>r.date==='2026-09-01');
  assert.equal(saved.rating,3.47);assert.equal(saved.reviews,101);assert.equal(saved.pv,100);
});
test('未取得が0に置き換えられた保存値を拒否する',()=>{
  assert.throws(()=>verifySnapshots([{date:'2026-09-01',rating:null}],[{date:'2026-09-01',rating:0}]),/未取得/);
});
test('部分取得は警告と少なくとも1項目の実測値を必須とする',()=>{
  assert.throws(()=>validateTabelogResult({status:'partial',data:{},daily:[],monthly:[],warning:'未取得'}),/保存できる/);
  assert.throws(()=>validateTabelogResult({status:'partial',data:{},daily:sample().daily,monthly:[]}),/未取得/);
  assert.throws(()=>validateTabelogResult({status:'partial',data:{rating:NaN},daily:sample().daily,monthly:[],warning:'未取得'}),/正しく/);
});
