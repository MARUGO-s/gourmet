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
