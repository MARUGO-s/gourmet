import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeOwnerReviews, ownerGoto, selectAllMonths} from '../tabelog-owner.js';
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
test('owner review collection never requests public metrics or fabricates an official aggregate',async()=>{
  const owner=mergeOwnerReviews({total:1,items:[review('B1','11')]},{total:0,items:[]});
  const result=await collectTabelogMetrics({ownerReviews:async()=>owner,publicMetrics:()=>assert.fail('Public request'),dailyMetrics:async()=>({daily:[]}),monthlyMetrics:async()=>({months:[]}),detailReports:async()=>({})});
  assert.equal(result.status,'partial');assert.deepEqual(result.data,{rating:null,reviews:null});assert.equal(result.reviews.length,1);
  assert.equal(snapshotUpdates('u','tabelog',result).length,0);
  assert.equal(result.reports.ownerReviews.groups,1);
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
