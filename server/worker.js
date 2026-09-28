import "dotenv/config";
import { syncOne } from "./scraper.js";

const endpoint="https://ycsqfajidusuibqljjwr.supabase.co/functions/v1/review-worker";
const token=process.env.GOURMET_WORKER_TOKEN;
if(!token) throw new Error("GOURMET_WORKER_TOKEN is required");

async function request(payload, retries=2) {
  for(let attempt=0;;attempt++) {
    try {
      const response=await fetch(endpoint,{method:"POST",headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(30_000)});
      if(!response.ok) { const error=new Error(`Worker API returned ${response.status}`); error.retryable=response.status>=500; throw error; }
      return await response.json();
    } catch(error) {
      if(error.retryable===false || attempt>=retries) throw error;
      await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));
    }
  }
}

// Bounded runner. Credentials and authenticated HTML never go to logs/artifacts.
for(let count=0;count<4;count++) {
  // A lost claim response must not silently claim a second job.
  const {job}=await request({action:"claim"},0);
  if(!job) { console.log("No queued sync jobs."); break; }
  let progress=Promise.resolve();
  let result;
  try {
    result=await syncOne(job.source,job.credential,{onProgress:(step,message)=>{
      progress=progress.then(()=>request({action:"progress",id:job.id,lease:job.lease,step,message},0)).catch(()=>{});
    }});
  } catch {
    result={status:"error",step:"worker",message:"取得中に通信エラーが発生しました。しばらく待ってから再同期してください"};
  }
  job.credential=null;
  await progress;
  await request({action:"result",id:job.id,lease:job.lease,result});
  console.log(`Sync finished: ${result.status === "ok" ? "saved" : result.status === "partial" ? "partially saved; some metrics unavailable" : "needs attention"}.`);
  if (result.status === "partial") console.log("::warning::Partial sync saved. Some metrics remain unavailable; see the dashboard warning.");
  // An Actions green check must not imply extraction succeeded when it did not.
  if (!["ok", "partial"].includes(result.status)) process.exitCode = 1;
}
