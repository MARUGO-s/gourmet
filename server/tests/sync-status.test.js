import test from 'node:test';
import assert from 'node:assert/strict';
import { getSyncState } from '../../src/lib/sync-status.ts';

test('queued running jobs are waiting, not fetching, and remain disabled', () => {
  assert.deepEqual(getSyncState({status:'running',step:'queued'}),{phase:'queued',busy:true,label:'開始待ち',animate:false});
});
test('request submission is distinct from waiting and fetching', () => {
  assert.equal(getSyncState(null,true).label,'依頼を送信中…');
  assert.equal(getSyncState({status:'completed',step:'finished'},true).phase,'submitting');
});
test('only claimed or progressing jobs show fetching', () => {
  for(const step of ['starting','browser','login','authentication','public_metrics','daily_pv','monthly','reports']) {
    assert.deepEqual(getSyncState({status:'running',step}),{phase:'fetching',busy:true,label:'取得中…',animate:true});
  }
});
test('finished jobs are not shown as waiting even if their last step is queued', () => {
  for(const status of ['completed','error']) assert.equal(getSyncState({status,step:'queued'}).busy,false);
  assert.equal(getSyncState(null).phase,'idle');
});
