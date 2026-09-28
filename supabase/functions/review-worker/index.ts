import { service, json, body } from "../_shared/http.ts";
import { decrypt } from "../_shared/crypto.ts";
import { must, validateTabelogResult, snapshotUpdates, japanDate } from "../_shared/sync-data.js";

async function authorized(req: Request) {
  const expected=Deno.env.get("GOURMET_WORKER_TOKEN");
  const actual=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
  if(!expected || !actual) return false;
  const digest=async(s:string)=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));
  const [a,b]=await Promise.all([digest(expected),digest(actual)]);
  return a.reduce((diff,n,i)=>diff|(n^b[i]),0)===0;
}
Deno.serve(async req=>{
  if(req.method!=="POST" || !await authorized(req)) return json(req,{error:"Unauthorized"},401);
  const admin=service();
  try {
    const input=await body(req);
    if(input.action==="claim") {
      const job=await must(admin.rpc("claim_sync"));
      if(!job?.id) return json(req,{job:null});
      try {
        const cred=await must(admin.from("credentials").select("username,password_enc").eq("user_id",job.user_id).eq("source","tabelog").single());
        return json(req,{job:{id:job.id,lease:job.lease_id,source:"tabelog",credential:{username:cred.username,password:await decrypt(cred.password_enc)}}});
      } catch {
        await must(admin.rpc("finish_sync",{p_job:job.id,p_lease:job.lease_id,p_result:{source:"tabelog",status:"error",message:"登録したアカウントを読み込めません。アカウント設定から登録し直してください"}}));
        return json(req,{job:null});
      }
    }
    if(!/^[0-9a-f-]{36}$/.test(input.id) || !/^[0-9a-f-]{36}$/.test(input.lease)) return json(req,{error:"Invalid job"},400);
    const job=await must(admin.from("sync_jobs").select("id,user_id,status,lease_until").eq("id",input.id).eq("lease_id",input.lease).maybeSingle());
    if(!job) return json(req,{error:"Invalid lease"},409);
    if(job.status!=="running") return json(req,{ok:true}); // Idempotent result retries.
    if(new Date(job.lease_until).getTime()<Date.now()) return json(req,{error:"Expired lease"},409);
    if(input.action==="progress") {
      const allowed=new Set(["browser","login","authentication","public_metrics","daily_pv","monthly","reports"]);
      if(!allowed.has(input.step)) return json(req,{error:"Invalid step"},400);
      await must(admin.from("sync_jobs").update({step:input.step,message:String(input.message??"").slice(0,200)}).eq("id",job.id).eq("status","running").eq("lease_id",input.lease));
      return json(req,{ok:true});
    }
    if(input.action!=="result") return json(req,{error:"Invalid action"},400);
    const result=input.result;
    let publicResult:any={source:"tabelog",status:"error",step:String(result?.step??"worker").slice(0,50),message:String(result?.message??"取得処理を完了できませんでした").slice(0,500)};
    let snapshots:any[]=[],reviews:any[]=[],reports:any[]=[];
    if(result?.status==="ok") {
      validateTabelogResult(result);
      if(result.daily.length>2000 || result.monthly.length>120 || (result.reviews?.length??0)>100) throw new Error("Oversized result");
      snapshots=snapshotUpdates(job.user_id,"tabelog",result);
      reviews=(result.reviews??[]).map((r:any)=>({text:String(r.text??"").slice(0,10000),author:String(r.author??"匿名").slice(0,300),rating:Number.isFinite(r.rating)&&r.rating>=0&&r.rating<=5?r.rating:0}));
      const add=(kind:string,period:string,data:unknown)=>reports.push({kind,period,data});
      for(const d of result.daily) if(d.pc!=null||d.sp!=null||d.app!=null) add("device_daily",d.date,{pc:d.pc,sp:d.sp,app:d.app});
      for(const {month,...metrics} of result.monthly) add("monthly_metrics",month,metrics);
      if(result.reports?.ranking) add("area_ranking",result.reports.ranking.updatedAt??japanDate(),result.reports.ranking);
      if(result.reports?.topPages) add("top_pages",result.reports.topPages.month,result.reports.topPages);
      publicResult={source:"tabelog",status:"ok",warning:result.warning,summary:{rating:result.data.rating,reviews:result.data.reviews,dailyDays:result.daily.length,monthlyMonths:result.monthly.length,latestPvDate:result.daily.map((d:any)=>d.date).sort().at(-1)}};
    }
    await must(admin.rpc("finish_sync",{p_job:input.id,p_lease:input.lease,p_result:publicResult,p_snapshots:snapshots,p_reviews:reviews,p_reports:reports}));
    return json(req,{ok:true});
  } catch {
    return json(req,{error:"Worker request failed; existing data was preserved"},500);
  }
});
