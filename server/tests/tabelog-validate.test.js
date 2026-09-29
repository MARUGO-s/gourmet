import test from "node:test";
import assert from "node:assert/strict";
// 食べログの取得結果の検証とレポート読み取り（エージェント側モジュール scripts/tabelog/）
import { japanDate } from "../../supabase/functions/_shared/sync-data.js";
import { validateTabelogResult } from "../../scripts/tabelog/validate.js";
import { toDailyPv, readConversionTable, buildRanking } from "../../scripts/tabelog/reports.js";
import { tabelogResultToPayload } from "../../scripts/tabelog/payload.js";
import { normalizeSourceIngest } from "../../supabase/functions/_shared/source-ingest.js";

const sample = () => ({
  data: { rating: 3.26, reviews: 49 },
  daily: [{ date: "2026-09-01", pv: 100, pc: 20, sp: 70, app: 10 }, { date: "2026-09-02", pv: 0, pc: 0, sp: 0, app: 0 }],
  monthly: [{ month: "2026-09", reservations: 4, pv: 100, pc: 20, sp: 70, app: 10 }],
  reviews: [{ text: "新しい口コミ", author: "test", rating: 4 }],
});

test("保存日はサーバーのタイムゾーンによらず日本時間", () => {
  assert.equal(japanDate(new Date("2026-09-28T15:10:00Z")), "2026-09-29");
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

test('部分取得は未取得を0や当日の評価として送らない', ()=>{
  const result=sample(); result.status='partial'; result.warning='評価・口コミ数は未取得'; result.data={rating:null,reviews:null};
  const payload=tabelogResultToPayload(result,{storeKey:'13245351',runId:'t1',capturedAt:'2026-09-29T09:00:00+09:00',today:'2026-09-29'});
  assert.equal(payload.stores[0].summary,null);
  assert.equal(payload.warning,'評価・口コミ数は未取得');
  const checked=normalizeSourceIngest(payload,'2026-09-29');
  assert.equal(checked.run.status,'partial');
  assert.equal(checked.stores[0].rating,null);
});
test('食べログの取得結果を共通形式に変換し、端末別の内訳差を pvOther として保持する', ()=>{
  const result={...sample(),status:'ok'}; result.daily[0]={date:'2026-09-01',pv:101,pc:20,sp:70,app:10,unclassified:1};
  result.monthly[0]={month:'2026-08',reservations:4,pv:100,pc:20,sp:70,app:10,calls:2,mapPrints:3};
  result.reviews=[{externalId:'B1:11',groupId:'B1',rating:3.47,date:'2026-09-01',visitMonth:'2026-08',text:'本文',author:'x',details:{textComplete:true,scores:[{label:'夜',value:3.47,breakdown:null}],ownerReply:{text:'ありがとうございます',date:'2026/09/02',status:'公開中'}}},{text:'公開抜粋',rating:4}];
  result.reports={ranking:{updatedAt:'2026-09-28',entries:[]},ownerReviews:{groups:1,entries:1}};
  const payload=tabelogResultToPayload(result,{storeKey:'13245351',runId:'t2',capturedAt:'2026-09-29T09:00:00+09:00',today:'2026-09-29'});
  const [store]=payload.stores;
  assert.deepEqual(store.daily[0],{date:'2026-09-01',pv:101,pvPc:20,pvSp:70,pvApp:10,pvOther:1});
  assert.equal(store.daily[1].pvOther,0);
  assert.deepEqual(store.monthly[0].extra,{mapPrints:3});
  assert.equal(store.reviews.items.length,1,'口コミIDの無い公開抜粋は送らない');
  assert.equal(store.reviews.items[0].reply.date,'2026-09-02');
  assert.deepEqual(store.reports.map(r=>r.kind),['area_ranking','owner_reviews']);
  const checked=normalizeSourceIngest(payload,'2026-09-29');
  assert.equal(checked.stores[0].days[0].pv_other,1);
  assert.equal(checked.stores[0].rating,3.26);
  assert.equal(checked.stores[0].reviews[0].needs_reply,null,'食べログは返信要否を推測しない');
});
test('部分取得は警告と少なくとも1項目の実測値を必須とする',()=>{
  assert.throws(()=>validateTabelogResult({status:'partial',data:{},daily:[],monthly:[],warning:'未取得'}),/保存できる/);
  assert.throws(()=>validateTabelogResult({status:'partial',data:{},daily:sample().daily,monthly:[]}),/未取得/);
  assert.throws(()=>validateTabelogResult({status:'partial',data:{rating:NaN},daily:sample().daily,monthly:[],warning:'未取得'}),/正しく/);
});
