// Opt-in integration test for the external-agent model (after migrations 010/011 and deploying the 3 functions).
// Creates two temporary users and removes ONLY those users (and their cascaded rows) in finally.
// Never calls agent-api with a valid token (that would write to INGEST_USER_ID) and never logs in to a restaurant site.
//   GOURMET_TEST_SERVICE_KEY=... node scripts/verify-cloud.mjs
import {createClient} from '@supabase/supabase-js';
import {randomUUID,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {normalizeSourceIngest} from '../supabase/functions/_shared/source-ingest.js';
const url='https://ycsqfajidusuibqljjwr.supabase.co';
const key='sb_publishable_xAOS8yDSozbiGYnEwejKwQ_SZ4MYMmB';
if(!process.env.GOURMET_TEST_SERVICE_KEY) throw new Error('GOURMET_TEST_SERVICE_KEY is required');
const admin=createClient(url,process.env.GOURMET_TEST_SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const users=[];
const check=async(query)=>{const {data,error}=await query;if(error)throw new Error(`${error.code} ${error.message}`);return data;};
const api=async(path,access,method='GET',body)=>{
  const r=await fetch(`${url}/functions/v1/review-api${path}`,{method,headers:{apikey:key,...(access?{authorization:`Bearer ${access}`}:{}) ,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json()};
};
const agent=async(path,token)=>(await fetch(`${url}/functions/v1/agent-api${path}`,{method:'POST',headers:{'x-ingest-token':token,'content-type':'application/json'},body:'{}'})).status;
try {
  assert.equal((await api('/credentials')).status,401);
  assert.equal(await agent('/requests/pending','invalid-token-for-verification-only-000000'),401,'agent-api must reject unknown tokens');
  assert.equal((await fetch(`${url}/functions/v1/review-worker`,{method:'POST'})).status,410,'review-worker is retired');
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
  // 資格情報: 暗号化・ブラウザから読めない
  assert.equal((await api('/credentials',a.access,'POST',{source:'tabelog',storeKey:'13245351',label:'integration fixture',username:'fixture-not-a-real-account',password:'fixture-password-never-used-for-login'})).status,200);
  const encrypted=await check(admin.from('credentials').select('password_enc,store_key').eq('user_id',a.id).single());
  assert.ok(encrypted.password_enc && !encrypted.password_enc.includes('fixture-password'));assert.equal(encrypted.store_key,'13245351');
  assert.equal((await api('/credentials',b.access)).data.length,0);
  assert.ok((await a.client.from('credentials').select('password_enc')).error,'Encrypted credentials must not be browser-readable');
  assert.ok((await a.client.from('credentials').select('username')).error,'Login IDs must not be browser-readable');
  assert.ok((await a.client.from('snapshots').insert({user_id:a.id,source:'tabelog',date:'2026-09-01'})).error,'Direct data mutations must be denied');
  assert.equal((await api('/sync',a.access,'POST',{source:'tabelog'})).status,410,'App-side sync is retired');
  // 取得依頼: 本人のみ登録・閲覧、重複は拒否、状態はブラウザから変更できない
  const req=await api('/requests',a.access,'POST',{source:'tabelog',storeId:'13245351',action:'sync_now'});assert.equal(req.status,201);
  assert.equal((await api('/requests',a.access,'POST',{source:'tabelog',storeId:'13245351',action:'sync_now'})).status,409,'Duplicate open request');
  assert.equal((await api('/requests',b.access)).data.requests.length,0);
  assert.ok((await a.client.from('agent_requests').update({status:'done'}).eq('id',req.data.request.id)).error,'Browser has no UPDATE on requests');
  assert.equal((await check(admin.from('agent_requests').select('status').eq('id',req.data.request.id).single())).status,'queued','Browser cannot change status');
  assert.ok((await a.client.from('agent_requests').select('claim_id')).error,'claim_id is not browser-readable');
  const [claimed]=await check(admin.rpc('claim_agent_requests',{p_user:a.id,p_agent:'verify',p_limit:1,p_source:null}));
  assert.equal(claimed.id,req.data.request.id);
  assert.ok((await admin.rpc('finish_agent_request',{p_user:a.id,p_id:claimed.id,p_claim:randomUUID(),p_status:'done'})).error,'Wrong claim id is rejected');
  await check(admin.rpc('finish_agent_request',{p_user:a.id,p_id:claimed.id,p_claim:claimed.claim_id,p_status:'done',p_result:{days:1}}));
  assert.equal((await api('/requests',a.access)).data.requests[0].status,'done');
  // 取り込み: 検証済みの共通形式を1トランザクションで保存・再送は冪等・他の利用者からは見えない
  const n=normalizeSourceIngest({schemaVersion:1,source:'tabelog',runId:'verify-1',stores:[{storeKey:'13245351',summary:{rating:3.47,reviewCount:101},daily:[{date:'2026-09-01',pv:42,pvPc:20,pvSp:20,pvApp:2,pvOther:0}],monthly:[{month:'2026-08',reservations:9}],reviews:{total:1,items:[{externalId:'B1:11',rating:3.47,text:'Integration fixture'}]}}]});
  for(let i=0;i<2;i++) await check(admin.rpc('ingest_source',{p_user:a.id,p_source:n.source,p_run:n.run,p_stores:n.stores}));
  const saved=await check(admin.from('snapshots').select('date,rating,reviews,pv,reservations').eq('user_id',a.id).eq('source','tabelog'));
  assert.equal(saved.find(r=>r.date==='2026-09-01').pv,42);assert.equal(saved.find(r=>r.date==='2026-08-01').reservations,9);
  assert.ok(saved.some(r=>Number(r.rating)===3.47 && r.reviews===101),'Two-decimal rating preserved');
  assert.equal((await check(a.client.from('source_reviews').select('external_id'))).length,1);
  assert.equal((await check(b.client.from('source_daily_metrics').select('date'))).length,0);
  assert.ok((await a.client.rpc('ingest_source',{p_user:a.id,p_source:'tabelog',p_run:n.run,p_stores:n.stores})).error,'Browser cannot call ingest');
  const dash=await api('/dashboard?source=tabelog',a.access);assert.equal(dash.status,200);assert.equal(dash.data.kpis.rating.value,3.47);
  const sources=await api('/sources',a.access);assert.ok(sources.data.find(s=>s.id==='tabelog').lastUpdatedAt,'Last ingest time is shown');
  console.log('PASS: demo, retired sync/worker, agent-api auth, encrypted credentials, cross-user isolation, request queue (dedupe, claim, finish), idempotent ingest, decimal precision, dashboard. No restaurant login was attempted.');
} finally {
  for(const user of users) await check(admin.auth.admin.deleteUser(user.id));
  console.log(`Removed ${users.length} temporary integration users and their test data.`);
}
