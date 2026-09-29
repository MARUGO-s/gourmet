import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeOwnerReviews, ownerGoto, selectAllMonths,readOwnerDailyTable,readOwnerPublicUrl} from '../tabelog-owner.js';
import {collectTabelogMetrics} from '../tabelog-result.js';
import {validateTabelogResult, snapshotUpdates} from '../sync-data.js';
import {computeDashboard} from '../../supabase/functions/_shared/dashboard.js';

const review=(groupId,id,complete=true)=>({externalId:`${groupId}:${id}`,groupId,rating:3.47,date:complete?'2020-01-02':null,visitMonth:'2019-12',text:'同じ本文',details:{textComplete:complete,scores:[{label:'夜',value:3.47,breakdown:null}]}});
test('full text wins over its excerpt, while repeat visits and excerpt-only reviews remain distinct',()=>{
  const rows=mergeOwnerReviews({total:2,items:[review('B1','11'),review('B1','12')]},{total:2,items:[review('B1','excerpt',false),review('B2','excerpt',false)]});
  assert.deepEqual(rows.items.map(r=>r.externalId),['B1:11','B1:12','B2:excerpt']);
  assert.equal(rows.summary.groups,2);assert.equal(rows.summary.entries,3);assert.equal(rows.summary.fullText,2);assert.equal(rows.summary.excerpts,1);
  assert.equal(rows.items[2].date,null);
  assert.throws(()=>mergeOwnerReviews({total:2,items:[review('B1','11'),review('B1','11')]},{total:0,items:[]}),/件数/);
});
test('owner posts stay intact while the public page supplies the official aggregate',async()=>{
  const owner=mergeOwnerReviews({total:1,items:[review('B1','11')]},{total:0,items:[]});
  let calls=0;
  const result=await collectTabelogMetrics({
    ownerReviews:async()=>owner,
    publicMetrics:async()=>{calls++;return {rating:3.26,reviews:49,name:'店',reviewItems:[{text:'公開抜粋',rating:1,author:'x'}]};},
    dailyMetrics:async()=>({daily:[{date:'2026-09-28',pv:0}]}),
    monthlyMetrics:async()=>({months:[{month:'2026-08',reservations:0}]}),
    detailReports:async()=>({ranking:{rows:[]},topPages:{pages:[]}}),
  });
  assert.equal(calls,1);
  assert.equal(result.status,'ok');
  assert.deepEqual(result.data,{rating:3.26,reviews:49});
  assert.equal(result.reviews.length,1);
  assert.equal(result.reviews[0].text,'同じ本文');
  assert.equal(result.reports.ownerReviews.groups,1);
  const saved=snapshotUpdates('u','tabelog',result,'2026-09-29');
  assert.equal(saved.find(row=>row.date==='2026-09-29').rating,3.26);
  assert.equal(saved.find(row=>row.date==='2026-09-29').reviews,49);
});
test('a failed public page does not discard owner reviews or invent an aggregate',async()=>{
  const owner=mergeOwnerReviews({total:1,items:[review('B1','11')]},{total:0,items:[]});
  const result=await collectTabelogMetrics({ownerReviews:async()=>owner,publicMetrics:async()=>({rating:null,reviews:null,issue:'公開ページがHTTP 403を返しました',reviewItems:[]}),dailyMetrics:async()=>({daily:[]}),monthlyMetrics:async()=>({months:[]}),detailReports:async()=>({})});
  assert.equal(result.status,'partial');
  assert.deepEqual(result.data,{rating:null,reviews:null});
  assert.equal(result.reviews[0].externalId,'B1:11');
  assert.match(result.warning,/HTTP 403/);
  assert.equal(snapshotUpdates('u','tabelog',result).length,0);
});
test('the owner navigation link identifies only this store',()=>{
  const original=globalThis.document;
  const anchor=(text,href)=>({textContent:text,href});
  globalThis.document={querySelectorAll:()=>[
    anchor('パザパ','https://tabelog.com/tokyo/A1309/A130903/13000975/'),
    anchor('自店舗ページ表示','https://tabelog.com/tokyo/A1309/A130903/13245351/?lid=owner_rst-top-jitempo_pc'),
  ]};
  try { assert.equal(readOwnerPublicUrl(),'https://tabelog.com/tokyo/A1309/A130903/13245351/'); }
  finally { globalThis.document=original; }
  globalThis.document={querySelectorAll:()=>[anchor('外部','https://example.com/tokyo/A1309/A130903/13245351/')]};
  try { assert.equal(readOwnerPublicUrl(),null); }
  finally { globalThis.document=original; }
});
test('review identities, real dates and ratings are checked before saving',()=>{
  const result={status:'partial',warning:'店舗総合点未取得',data:{rating:null,reviews:null},daily:[],monthly:[],reviews:[review('B1','11')]};
  assert.doesNotThrow(()=>validateTabelogResult(result));
  for(const change of [r=>r.date='2020-02-30',r=>r.visitMonth='2020-13',r=>r.rating=5.1,r=>r.externalId='other',r=>r.details.textComplete=null]){
    const invalid=structuredClone(result);change(invalid.reviews[0]);assert.throws(()=>validateTabelogResult(invalid));
  }
  assert.throws(()=>validateTabelogResult({...result,reviews:[result.reviews[0],result.reviews[0]]}),/識別/);
});
test('historic months with unpublished reservations retain null instead of a zero snapshot',()=>{
  const result={status:'partial',warning:'予約未掲載',data:{rating:null,reviews:null},daily:[{date:'2019-12-01',pv:0}],monthly:[{month:'2019-12',reservations:null,pv:0}],reviews:[]};
  validateTabelogResult(result);
  assert.deepEqual(snapshotUpdates('u','tabelog',result),[{user_id:'u',source:'tabelog',date:'2019-12-01',pv:0}]);
});
test('dashboard returns every review, retains null dates, and keeps individual scores out of KPIs',()=>{
  const reviews=Array.from({length:53},(_,i)=>({...review(`B${i+1}`,'excerpt',false),id:String(i),source:'tabelog',visit_month:'2026-08'}));
  const data=computeDashboard([],reviews,null,['tabelog'],false);
  assert.equal(data.reviews.length,53);assert.equal(data.reviews[0].date,null);assert.equal(data.kpis.rating.value,null);assert.equal(data.kpis.reviews.value,null);
});
test('selecting an already complete range does not wait for navigation that will never happen',async()=>{
  const first={waitFor:async()=>{},inputValue:async()=>'201912',locator:()=>({evaluateAll:async()=>['202608','201912']}),selectOption:()=>assert.fail('No navigation')};
  const page={locator:s=>s==='#report-month-first'?first:{inputValue:async()=>'202608'},waitForNavigation:()=>assert.fail('No navigation')};
  assert.deepEqual(await selectAllMonths(page,async()=>{}),{first:'201912',last:'202608'});
});
test('owner navigation rejects external origins and redirects',async()=>{
  const page={goto:async()=>({status:()=>200}),url:()=>'https://other.example/'};
  await assert.rejects(ownerGoto(page,'https://other.example/',async()=>{}),/以外/);
  await assert.rejects(ownerGoto(page,'https://owner.tabelog.com/owner_rst/top',async()=>{}),/拒否/);
});
test('historic owner totals retain the displayed device counts and their explicit nonnegative difference',()=>{
  const original=globalThis.document;
  globalThis.document={querySelector:()=>({rows:[{cells:['2020-10-02 (金)','48','33','57','139'].map(textContent=>({textContent}))}]})};
  try {
    const [row]=readOwnerDailyTable();
    assert.deepEqual(row,{date:'2020-10-02',pc:48,sp:33,app:57,pv:139,unclassified:1});
    const result={status:'partial',warning:'公開総合点未取得',data:{},daily:[row],monthly:[{month:'2020-10',pv:5415,pc:869,sp:1501,app:3021,unclassified:24,reservations:2}]};
    assert.doesNotThrow(()=>validateTabelogResult(result));
    for(const difference of [undefined,2,-1]) assert.throws(()=>validateTabelogResult({...result,daily:[{...row,unclassified:difference}]}));
    assert.throws(()=>validateTabelogResult({...result,monthly:[{...result.monthly[0],unclassified:25}]}));
  } finally {globalThis.document=original;}
});
