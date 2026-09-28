import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTabelogMetrics } from '../tabelog-result.js';

const collectors = () => ({
  publicMetrics:async()=>({rating:3.26,reviews:0,reviewItems:[]}),
  dailyMetrics:async()=>({daily:[{date:'2026-09-28',pv:0}]}),
  monthlyMetrics:async()=>({months:[{month:'2026-08',reservations:0}]}),
  detailReports:async()=>({}),
});
test('403 leaves public metrics unknown, but owner PV and reservations are saved as partial',async()=>{
  const c=collectors(); let requests=0;
  c.publicMetrics=async()=>{requests++;return {rating:null,reviews:null,issue:'公開ページがHTTP 403を返しました',reviewItems:[]};};
  const result=await collectTabelogMetrics(c);
  assert.equal(requests,1); assert.equal(result.status,'partial');
  assert.equal(result.data.rating,null); assert.equal(result.data.reviews,null);
  assert.equal(result.daily[0].pv,0); assert.equal(result.monthly[0].reservations,0);
  assert.match(result.warning,/HTTP 403/); assert.match(result.warning,/未取得/);
});
test('public timeout is isolated and never triggers a bypass or retry',async()=>{
  const c=collectors(); c.publicMetrics=async()=>{throw new Error('timeout');};
  const result=await collectTabelogMetrics(c);
  assert.equal(result.status,'partial'); assert.equal(result.daily.length,1);
});
test('a missing owner report does not discard other valid fields',async()=>{
  const c=collectors(); c.dailyMetrics=async()=>{throw new Error('missing chart');};
  const result=await collectTabelogMetrics(c);
  assert.equal(result.status,'partial'); assert.equal(result.data.rating,3.26); assert.equal(result.monthly.length,1);
});
test('complete public/core metrics are ok; optional report warning remains visible',async()=>{
  const result=await collectTabelogMetrics(collectors());
  assert.equal(result.status,'ok'); assert.match(result.warning,/エリア順位/);
});
test('all-empty collection is an error, not successful partial sync',async()=>{
  const c=collectors(); c.publicMetrics=async()=>({}); c.dailyMetrics=async()=>({}); c.monthlyMetrics=async()=>({});
  const result=await collectTabelogMetrics(c); assert.equal(result.status,'error');
});
test('owner additional authentication stops the run instead of silently falling back',async()=>{
  const c=collectors(); c.dailyMetrics=async()=>{throw new Error('追加認証が必要です');};
  c.monthlyMetrics=async()=>assert.fail('must not continue after owner authentication challenge');
  await assert.rejects(collectTabelogMetrics(c),/追加認証/);
});
test('malformed extracted numbers are not converted to partial success',async()=>{
  const c=collectors(); c.dailyMetrics=async()=>({daily:[{date:'2026-09-28',pv:-1}]});
  await assert.rejects(collectTabelogMetrics(c),/不正/);
});
