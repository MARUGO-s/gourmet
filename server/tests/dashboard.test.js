import test from 'node:test';
import assert from 'node:assert/strict';
import {computeDashboard} from '../../supabase/functions/_shared/dashboard.js';
test('all gourmet sites retain two-digit ratings in aggregate',()=>{
  const sites=['tabelog','hotpepper','google','ikyu','retty','toreta'];
  for(const source of sites) {
    const data=computeDashboard([{source,date:'2026-09-01',rating:3.47,reviews:100,pv:10,reservations:0}],[],null,[source],false);
    assert.equal(data.kpis.rating.value,3.47);
  }
});
test('source filtering never includes another source',()=>{
  const data=computeDashboard([{source:'tabelog',date:'2026-09-01',rating:3.47,reviews:100,pv:10,reservations:0},{source:'google',date:'2026-09-01',rating:5,reviews:900,pv:999,reservations:0}],[],null,['tabelog'],false);
  assert.equal(data.kpis.rating.value,3.47); assert.equal(data.kpis.reviews.value,100);
});
test('missing metrics remain null while genuine zero PV and reservations remain visible',()=>{
  const data=computeDashboard([
    {source:'tabelog',date:'2026-08-01',rating:null,reviews:null,pv:null,reservations:0},
    {source:'tabelog',date:'2026-09-27',rating:null,reviews:null,pv:5,reservations:null},
    {source:'tabelog',date:'2026-09-28',rating:null,reviews:null,pv:0,reservations:null},
  ],[],null,['tabelog'],false);
  assert.equal(data.kpis.rating.value,null); assert.equal(data.kpis.reviews.value,null);
  assert.deepEqual(data.series,[{date:'2026-09-27',pv:5},{date:'2026-09-28',pv:0}]);
  assert.equal(data.kpis.reservations.month,'2026-08');assert.equal(data.kpis.reservations.value,0);
});
test('latest rating and review dates are independent and do not advance for PV-only sync',()=>{
  const data=computeDashboard([
    {source:'tabelog',date:'2026-08-01',rating:3.26,reviews:10,pv:null,reservations:null},
    {source:'tabelog',date:'2026-09-01',rating:null,reviews:0,pv:null,reservations:null},
    {source:'tabelog',date:'2026-09-28',rating:null,reviews:null,pv:10,reservations:null},
  ],[],null,['tabelog'],false);
  assert.equal(data.kpis.rating.value,3.26); assert.equal(data.kpis.rating.asOf,'2026-08-01');
  assert.equal(data.kpis.reviews.value,0); assert.equal(data.kpis.reviews.asOf,'2026-09-01');
  assert.equal(data.kpis.reservations.value,null);
});
test('empty dashboard and entirely zero measured PV are distinguishable',()=>{
  const empty=computeDashboard([],[],null,['tabelog'],false); assert.equal(empty.kpis.pv.value,null);
  const zero=computeDashboard([{source:'tabelog',date:'2026-09-28',pv:0}],[],null,['tabelog'],false);
  assert.equal(zero.kpis.pv.value,0);assert.equal(zero.series.length,1);assert.equal(zero.kpis.pv.delta,null);
});
