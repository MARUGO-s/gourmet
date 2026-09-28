import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { SOURCES, SOURCE_IDS, getSource } from "../_shared/sources.js";
import { buildSeed } from "../_shared/seed.js";
import { computeDashboard, loadDetails } from "../_shared/dashboard.js";
import { must } from "../_shared/sync-data.js";
import { encrypt } from "../_shared/crypto.ts";
import { service, json, body, publicJob } from "../_shared/http.ts";
import { dispatchWorker } from "../_shared/dispatch.js";

const demo = buildSeed();
const credentialColumns = "id,source,label,username,updated_at";
const jobColumns = "id,sources,status,step,message,started_at,finished_at,results,dispatch_status";

Deno.serve(async req => {
  if (req.method === "OPTIONS") return json(req, {});
  const path = new URL(req.url).pathname.replace(/^.*\/review-api/, "");
  const admin = service();
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  let user = null;
  if (token) {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return json(req, { error:"ログインし直してください" },401);
    user = data.user;
  }
  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: token ? { Authorization:`Bearer ${token}` } : {} }, auth:{persistSession:false,autoRefreshToken:false},
  });
  try {
    if (path === "/sources" && req.method === "GET") {
      const creds = user ? await must(client.from("credentials").select("source")) : [];
      return json(req, SOURCES.map(s => ({ id:s.id, name:s.name, nameEn:s.nameEn,color:s.color,loginUrl:s.loginUrl,hasCredential:creds.some((c:any)=>c.source===s.id) })));
    }
    if (path === "/dashboard" && req.method === "GET") {
      const source = new URL(req.url).searchParams.get("source") || "all";
      if (source !== "all" && !getSource(source)) return json(req,{error:"不明なサイトです"},400);
      const targets = source === "all" ? SOURCE_IDS : [source];
      if (!user) return json(req,{...computeDashboard(demo.snapshots,demo.reviews,null,targets,true),details:null});
      // Paginate historic snapshots: PostgREST otherwise truncates at 1,000 rows.
      const snapshots:any[] = [];
      for (let offset=0;;offset+=1000) {
        const rows = await must(client.from("snapshots").select("source,date,rating,reviews,pv,visits,reservations").in("source",targets).order("id").range(offset,offset+999));
        snapshots.push(...rows);
        if (rows.length<1000) break;
      }
      const [reviews, logs] = await Promise.all([
        must(client.from("reviews").select("id,source,rating,text,author,sentiment,review_date").in("source",targets).order("review_date",{ascending:false}).limit(20)),
        must(client.from("sync_log").select("at").in("source",targets).eq("status","ok").order("at",{ascending:false}).limit(1)),
      ]);
      const dashboard=computeDashboard(snapshots,reviews.map((r:any)=>({...r,rating:Number(r.rating),date:r.review_date})),logs[0]?.at??null,targets,false);
      const details=targets.includes("tabelog")?await loadDetails(client,"tabelog",dashboard.series[0]?.date):null;
      return json(req,{...dashboard,details});
    }
    if (!user) return json(req,{error:"ログインが必要です"},401);
    if (path === "/credentials" && req.method === "GET") {
      const rows=await must(client.from("credentials").select(credentialColumns).order("updated_at",{ascending:false}));
      return json(req,rows.map((r:any)=>({...r,updatedAt:r.updated_at})));
    }
    if (path === "/credentials" && req.method === "POST") {
      const input=await body(req);
      if(!getSource(input.source) || typeof input.username!=="string" || !input.username.trim() || input.username.length>320 || typeof input.password!=="string" || !input.password || input.password.length>1000 || (input.label && (typeof input.label!=="string" || input.label.length>200))) return json(req,{error:"サイト・ID・パスワードをご確認ください"},400);
      await must(admin.from("credentials").upsert({user_id:user.id,source:input.source,label:input.label||"",username:input.username.trim(),password_enc:await encrypt(input.password),updated_at:new Date().toISOString()},{onConflict:"user_id,source"}));
      return json(req,{ok:true});
    }
    if (/^\/credentials\/[0-9a-f-]{36}$/.test(path) && req.method === "DELETE") {
      await must(admin.from("credentials").delete().eq("user_id",user.id).eq("id",path.split("/").at(-1)));
      return json(req,{ok:true});
    }
    if (path === "/sync" && req.method === "POST") {
      const { source }=await body(req);
      if(source!=="all" && source!=="tabelog") return json(req,{error:"現在の自動取得は食べログのみ対応しています。他サイトは接続準備中です"},422);
      const {data,error}=await admin.rpc("enqueue_sync",{p_user:user.id});
      if(error) return json(req,{error:error.message.includes("同期は")?error.message:"食べログのアカウントを登録してから再度お試しください"},error.message.includes("同期は")?429:400);
      const reserved=await must(admin.rpc("reserve_sync_dispatch",{p_job:data.id,p_user:user.id}));
      if(reserved) {
        const dispatched=await dispatchWorker(Deno.env.get("GOURMET_DISPATCH_TOKEN"));
        await must(admin.from("sync_jobs").update({dispatch_status:dispatched.status,message:dispatched.message})
          .eq("id",data.id).eq("user_id",user.id).eq("status","running").eq("step","queued").is("lease_id",null));
      }
      const current=await must(client.from("sync_jobs").select(jobColumns).eq("id",data.id).single());
      return json(req,publicJob(current),202);
    }
    if (path === "/sync/active" && req.method === "GET") {
      await must(admin.rpc("expire_sync_jobs"));
      // Also restore the last completed/error result after reload or sign-in.
      const rows=await must(client.from("sync_jobs").select(jobColumns).order("started_at",{ascending:false}).limit(1));
      return json(req,{job:rows[0]?publicJob(rows[0]):null});
    }
    if (/^\/sync\/jobs\/[0-9a-f-]{36}$/.test(path) && req.method === "GET") {
      await must(admin.rpc("expire_sync_jobs"));
      const rows=await must(client.from("sync_jobs").select(jobColumns).eq("id",path.split("/").at(-1)));
      return rows[0]?json(req,publicJob(rows[0])):json(req,{error:"同期処理が見つかりません"},404);
    }
    return json(req,{error:"ページが見つかりません"},404);
  } catch {
    // Do not expose SQL errors, tokens, or credential inputs in public logs.
    return json(req,{error:"処理を完了できませんでした。時間をおいて再度お試しください"},500);
  }
});
