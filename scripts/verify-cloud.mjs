// Opt-in integration test. Creates two temporary users and removes ONLY those users in finally.
// Run only on the new gourmet project before accepting production sync jobs.
import {createClient} from '@supabase/supabase-js';
import {randomUUID,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const url='https://ycsqfajidusuibqljjwr.supabase.co';
const key='sb_publishable_xAOS8yDSozbiGYnEwejKwQ_SZ4MYMmB';
const admin=createClient(url,process.env.GOURMET_TEST_SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const token=process.env.GOURMET_WORKER_TOKEN;
if(!token) throw new Error('Test worker token is required');
const users=[];
const check=async(query)=>{const {data,error}=await query;if(error)throw new Error(error.code);return data;};
const api=async(path,access,method='GET',body)=>{
  const r=await fetch(`${url}/functions/v1/review-api${path}`,{method,headers:{apikey:key,...(access?{authorization:`Bearer ${access}`}:{}) ,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json()};
};
const worker=async(body,workerToken=token)=>{
  const r=await fetch(`${url}/functions/v1/review-worker`,{method:'POST',headers:{authorization:`Bearer ${workerToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
};
try {
  const active=await check(admin.from('sync_jobs').select('id').eq('status','running'));
  assert.equal(active.length,0,'Do not test while production jobs are queued');
  assert.equal((await api('/credentials')).status,401);
  assert.equal((await worker({action:'claim'},'invalid')).status,401);
  const demo=await api('/dashboard'); assert.equal(demo.status,200);assert.equal(demo.data.demo,true);
  for(let i=0;i<2;i++) {
    const email=`gourmet-integration-${randomUUID()}@example.invalid`;
    const password=randomBytes(32).toString('hex');
    const data=await check(admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{purpose:'temporary integration verification'}}));
    users.push({id:data.user.id});
    const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
    const login=await check(client.auth.signInWithPassword({email,password}));
    users.at(-1).access=login.session.access_token; users.at(-1).client=client;
  }
  const [a,b]=users;
  assert.equal((await api('/credentials',a.access,'POST',{source:'tabelog',label:'integration fixture',username:'fixture-not-a-real-account',password:'fixture-password-never-used-for-login'})).status,200);
  const encrypted=await check(admin.from('credentials').select('password_enc').eq('user_id',a.id).single());
  assert.ok(encrypted.password_enc && !encrypted.password_enc.includes('fixture-password'));
  assert.equal((await api('/credentials',b.access)).data.length,0);
  const secretRead=await a.client.from('credentials').select('password_enc');assert.ok(secretRead.error,'Encrypted credentials must not be browser-readable');
  const write=await a.client.from('snapshots').insert({user_id:a.id,source:'tabelog',date:'2026-09-01'});assert.ok(write.error,'Direct data mutations must be denied');
  const start=await api('/sync',a.access,'POST',{source:'tabelog'});
  if(start.status!==202) { const {error}=await admin.rpc('enqueue_sync',{p_user:a.id}); console.log('Queue diagnostic:',error?.code,error?.message); }
  assert.equal(start.status,202);
  assert.equal((await api('/sync',a.access,'POST',{source:'tabelog'})).data.id,start.data.id,'Duplicate sync should resume existing job');
  assert.equal((await api(`/sync/jobs/${start.data.id}`,b.access)).status,404);
  const claim=await worker({action:'claim'});assert.equal(claim.status,200);
  assert.equal(claim.data.job.id,start.data.id);assert.ok(claim.data.job.credential.password==='fixture-password-never-used-for-login','Encryption round trip');
  const {id,lease}=claim.data.job;
  const progress=await worker({action:'progress',id,lease,step:'daily_pv',message:'fixture progress'});assert.equal(progress.status,200);
  await check(admin.from('snapshots').insert({user_id:a.id,source:'tabelog',date:'2026-09-01',rating:3.42,reviews:90,pv:11,reservations:5}));
  const result={status:'ok',data:{rating:3.47,reviews:101},daily:[{date:'2026-09-01',pv:42,pc:20,sp:20,app:2},{date:'2026-09-02',pv:0}],monthly:[{month:'2026-09',reservations:9,pv:42,pc:20,sp:20,app:2}],reviews:[{rating:3.47,text:'Integration fixture',author:'Test'}],reports:{}};
  const invalid=await worker({action:'result',id,lease,result:{...result,data:{rating:-1,reviews:101}}});assert.equal(invalid.status,500);
  assert.equal((await check(admin.from('snapshots').select('pv').eq('user_id',a.id).eq('date','2026-09-01').single())).pv,11,'Invalid payload must leave previous data unchanged');
  assert.equal((await worker({action:'result',id,lease,result})).status,200);
  assert.equal((await worker({action:'result',id,lease,result})).status,200,'Result retry should be idempotent');
  const saved=await check(admin.from('snapshots').select('date,rating,reviews,pv,reservations').eq('user_id',a.id));
  const first=saved.find(r=>r.date==='2026-09-01');assert.equal(first.pv,42);assert.equal(first.reservations,9);assert.equal(first.rating,3.42);
  assert.ok(saved.some(r=>r.rating===3.47 && r.reviews===101));
  assert.equal((await check(admin.from('reviews').select('rating').eq('user_id',a.id)))[0].rating,3.47);
  assert.equal((await check(admin.from('sync_log').select('id').eq('user_id',a.id))).length,1);
  const dash=await api('/dashboard?source=tabelog',a.access);assert.equal(dash.status,200);assert.equal(dash.data.kpis.rating.value,3.47);assert.equal(dash.data.demo,false);
  assert.equal((await api('/dashboard',b.access)).data.kpis.rating.value,0);
  assert.equal((await api(`/sync/jobs/${id}`,a.access)).data.status,'completed');
  const next=await api('/sync',a.access,'POST',{source:'tabelog'});assert.equal(next.status,202);
  await check(admin.from('sync_jobs').update({lease_id:randomUUID(),lease_until:'2000-01-01T00:00:00Z'}).eq('id',next.data.id));
  assert.equal((await api(`/sync/jobs/${next.data.id}`,a.access)).data.status,'error','Expired jobs must not remain running forever');
  console.log('PASS: demo, login, encrypted credential round-trip, cross-user isolation, denied direct writes, queue deduplication, progress, atomic save, decimal precision, retry idempotency, dashboard, timeout. No external restaurant login was attempted.');
} finally {
  for(const user of users) await check(admin.auth.admin.deleteUser(user.id));
  console.log(`Removed ${users.length} temporary integration users and their test data.`);
}
