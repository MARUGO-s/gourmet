// Isolated integration fixtures are pre-leased, never queued for a real scraper.
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
const worker=async(body,workerToken=token)=>{
  const r=await fetch(`${url}/functions/v1/review-worker`,{method:'POST',headers:{authorization:`Bearer ${workerToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
};
const dashboard=async(access)=>{
  const r=await fetch(`${url}/functions/v1/review-api/dashboard?source=tabelog`,{headers:{apikey:key,authorization:`Bearer ${access}`}});
  assert.equal(r.status,200);return r.json();
};
try {
  for(let i=0;i<2;i++) {
    const email=`gourmet-partial-${randomUUID()}@example.invalid`, password=randomBytes(32).toString('hex');
    const data=await check(admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{purpose:'temporary partial sync verification'}}));
    users.push({id:data.user.id});
    const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
    const login=await check(client.auth.signInWithPassword({email,password}));
    Object.assign(users.at(-1),{access:login.session.access_token,client});
  }
  const [a,b]=users;
  const createJob=async()=>{
    const id=randomUUID(),lease=randomUUID();
    await check(admin.from('sync_jobs').insert({id,user_id:a.id,status:'running',step:'starting',lease_id:lease,lease_until:new Date(Date.now()+600000).toISOString()}));
    return {id,lease};
  };
  const first=await createJob();
  const partial={status:'partial',warning:'評価・口コミ数は未取得（integration fixture）',data:{rating:null,reviews:null},daily:[{date:'2026-08-30',pv:42,pc:20,sp:20,app:2},{date:'2026-08-31',pv:0,pc:0,sp:0,app:0}],monthly:[{month:'2026-08',reservations:0}],reviews:[],reports:{}};
  assert.equal((await worker({action:'result',...first,result:partial},'invalid')).status,401);
  assert.equal((await worker({action:'result',...first,lease:randomUUID(),result:partial})).status,409);
  const invalid={...partial,daily:[{date:'2026-08-31',pv:-1}]};
  assert.equal((await worker({action:'result',...first,result:invalid})).status,500);
  assert.equal((await check(admin.from('snapshots').select('id').eq('user_id',a.id))).length,0);
  assert.equal((await worker({action:'result',...first,result:partial})).status,200);
  assert.equal((await worker({action:'result',...first,result:partial})).status,200);
  const rows=await check(admin.from('snapshots').select('date,rating,reviews,pv,reservations').eq('user_id',a.id));
  assert.equal(rows.length,3);assert.ok(rows.every(r=>r.rating===null&&r.reviews===null));
  assert.equal(rows.find(r=>r.date==='2026-08-31').pv,0);
  assert.equal(rows.find(r=>r.date==='2026-08-01').pv,null);
  assert.equal(rows.find(r=>r.date==='2026-08-01').reservations,0);
  const job=await check(admin.from('sync_jobs').select('status,message,results').eq('id',first.id).single());
  assert.equal(job.status,'completed');assert.equal(job.results[0].status,'partial');assert.match(job.message,/一部取得/);
  const log=await check(admin.from('sync_log').select('status').eq('user_id',a.id));assert.deepEqual(log,[{status:'partial'}]);
  const reports=await check(admin.from('source_reports').select('kind').eq('user_id',a.id));assert.equal(reports.length,3);
  const dash=await dashboard(a.access);
  assert.equal(dash.kpis.rating.value,null);assert.equal(dash.kpis.reviews.value,null);assert.equal(dash.kpis.pv.value,42);
  assert.equal(dash.kpis.reservations.value,0);assert.ok(dash.lastSync);assert.equal(dash.series.at(-1).pv,0);
  assert.equal((await dashboard(b.access)).series.length,0);
  assert.equal((await check(b.client.from('snapshots').select('id').eq('user_id',a.id))).length,0);
  assert.ok((await a.client.from('snapshots').insert({user_id:a.id,source:'tabelog',date:'2026-08-01'})).error);
  assert.ok((await a.client.rpc('finish_sync',{p_job:first.id,p_lease:first.lease,p_result:{source:'tabelog',status:'ok'}})).error);

  await check(admin.from('snapshots').update({rating:3.47,reviews:101}).eq('user_id',a.id).eq('date','2026-08-30'));
  const second=await createJob();
  assert.equal((await worker({action:'result',...second,result:partial})).status,200);
  const updated=await dashboard(a.access);assert.equal(updated.kpis.rating.value,3.47);assert.equal(updated.kpis.rating.asOf,'2026-08-30');assert.equal(updated.kpis.reviews.value,101);

  const third=await createJob();
  const full={...partial,status:'ok',warning:undefined,data:{rating:3.476,reviews:102}};
  assert.equal((await worker({action:'result',...third,result:full})).status,500,'Rounded values must roll back');
  assert.equal((await check(admin.from('sync_jobs').select('status').eq('id',third.id).single())).status,'running');
  assert.equal((await check(admin.from('sync_log').select('id').eq('user_id',a.id))).length,2);
  full.data.rating=3.48;
  assert.equal((await worker({action:'result',...third,result:full})).status,200);
  assert.equal((await dashboard(a.access)).kpis.rating.value,3.48);
  const ownerReviews=[
    {externalId:'B900000001:100001',date:'2020-01-02',visitMonth:'2019-12',title:'fixture title',author:'fixture',rating:3.47,text:'全文\n2行目',details:{textComplete:true,scores:[{label:'夜',value:3.47,breakdown:'料理・味 3.4'}],ownerReply:{text:'店舗返信',date:'2020/01/03',status:'公開中'}}},
    {externalId:'B900000002:excerpt',date:null,visitMonth:'2026-08',title:'',author:'fixture',rating:null,text:'抜粋',details:{textComplete:false,scores:[]}},
  ];
  const ownerResult={...partial,reviews:ownerReviews,reports:{ownerReviews:{groups:2,entries:2,fullText:1,excerpts:1},pageHistory:{first:'201912',last:'202608',devices:{pc:[{name:'トップ',pv:42}],sp:[],app:[]}}}};
  const fourth=await createJob();
  assert.equal((await worker({action:'result',...fourth,result:ownerResult})).status,200);
  const savedReviews=await check(admin.from('reviews').select('external_id,rating,text,review_date,visit_month,details').eq('user_id',a.id));
  assert.equal(savedReviews.length,2);
  const complete=savedReviews.find(r=>r.external_id===ownerReviews[0].externalId);
  assert.equal(complete.rating,3.47);assert.equal(complete.review_date,'2020-01-02');assert.equal(complete.text,ownerReviews[0].text);assert.deepEqual(complete.details,ownerReviews[0].details);
  const excerpt=savedReviews.find(r=>r.external_id===ownerReviews[1].externalId);assert.equal(excerpt.review_date,null);assert.equal(excerpt.rating,null);
  assert.equal((await check(b.client.from('reviews').select('id').eq('user_id',a.id))).length,0);
  const ownerDash=await dashboard(a.access);assert.equal(ownerDash.reviews.length,2);assert.equal(ownerDash.details.ownerReviews.fullText,1);assert.equal(ownerDash.details.pageHistory.first,'201912');
  const fifth=await createJob();ownerReviews[0].text+='\n更新';
  assert.equal((await worker({action:'result',...fifth,result:ownerResult})).status,200);
  assert.equal((await check(admin.from('reviews').select('id').eq('user_id',a.id))).length,2);
  const sixth=await createJob();ownerReviews[0].rating=3.476;
  assert.equal((await worker({action:'result',...sixth,result:ownerResult})).status,500,'Review rounding must roll back');
  assert.equal((await check(admin.from('sync_jobs').select('status').eq('id',sixth.id).single())).status,'running');
  ownerReviews[0].rating=3.48;
  const reviewsOnly={...ownerResult,daily:[],monthly:[]};
  assert.equal((await worker({action:'result',...sixth,result:reviewsOnly})).status,200);
  assert.equal((await dashboard(a.access)).reviews.find(r=>r.external_id===ownerReviews[0].externalId).rating,3.48);
  const seventh=await createJob();
  const historic={...ownerResult,daily:[{date:'2020-10-02',pv:139,pc:48,sp:33,app:57,unclassified:1}],monthly:[{month:'2020-10',pv:5415,pc:869,sp:1501,app:3021,unclassified:24,reservations:2}]};
  assert.equal((await worker({action:'result',...seventh,result:historic})).status,200);
  const historicReports=await check(admin.from('source_reports').select('kind,data').eq('user_id',a.id).in('period',['2020-10-02','2020-10']));
  assert.deepEqual(historicReports.find(r=>r.kind==='device_daily').data,{pc:48,sp:33,app:57,unclassified:1});
  assert.equal(historicReports.find(r=>r.kind==='monthly_metrics').data.unclassified,24);
  console.log('PASS: partial atomic save, NULL vs measured zero, unchanged historical rating, reports, API/dashboard, last sync, invalid payload rollback, decimals, idempotency, lease/auth checks, cross-user isolation. No restaurant login or GitHub dispatch was attempted.');
} finally {
  for(const user of users) await check(admin.auth.admin.deleteUser(user.id));
  console.log(`Removed ${users.length} temporary fixture users and their own test data.`);
}
