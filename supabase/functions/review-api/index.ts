import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { SOURCES, SOURCE_IDS, getSource } from "../_shared/sources.js";
import { buildSeed } from "../_shared/seed.js";
import { computeDashboard, loadDetails } from "../_shared/dashboard.js";
import { must } from "../_shared/sync-data.js";
import { encrypt } from "../_shared/crypto.ts";
import { service, json, body } from "../_shared/http.ts";
import { packIkyuUsername } from "../_shared/ikyu-login.js";
import { dropPublicDuplicates, loadIkyuDetails, loadIkyuReviews } from "../_shared/ikyu-data.js";
import { buildIkyuDemo } from "../_shared/seed.js";
import { loadSourceReviews, mergeReviews, loadIngestedDetails, overlayDetails, loadLastUpdated } from "../_shared/source-ingest.js";
import { validateRequestInput, publicRequest } from "../_shared/agent-requests.js";
import { japanDate } from "../_shared/sync-data.js";
import { validateScheduleInput, nextDueOnSave, publicSchedule } from "../_shared/fetch-schedules.js";

const demo = buildSeed();
// ログインID・暗号文はブラウザへ返さない（登録済み・更新日時のみ）
const credentialColumns = "id,source,label,store_key,credentials_version,updated_at";
const ikyuDemo = buildIkyuDemo();
// 一休の前年比には前年同月の日別値が必要なため、前年同月1日以降を読む
const ikyuFromDate = () => { const d = new Date(Date.now() + 9 * 3600_000); return `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`; };
const requestColumns = "id,source,store_id,action,params,status,requested_at,claimed_at,finished_at,claimed_by,attempts,result,error";

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
      // 全サイトとも外部エージェント（Grok Bot）が取り込む。最終取り込み日時は sync_log の成功記録。
      const updated: Record<string,string|null> = user ? await loadLastUpdated(client) : {};
      return json(req, SOURCES.map(s => ({ id:s.id, name:s.name, nameEn:s.nameEn,color:s.color,loginUrl:s.loginUrl,hasCredential:creds.some((c:any)=>c.source===s.id),
        storeCount:creds.filter((c:any)=>c.source===s.id).length, lastUpdatedAt:updated[s.id]??null })));
    }
    if (path === "/dashboard" && req.method === "GET") {
      const source = new URL(req.url).searchParams.get("source") || "all";
      if (source !== "all" && !getSource(source)) return json(req,{error:"不明なサイトです"},400);
      const targets = source === "all" ? SOURCE_IDS : [source];
      if (!user) return json(req,{...computeDashboard(demo.snapshots,demo.reviews,null,targets,true),details:null,ikyu:source==="ikyu"?ikyuDemo:null});
      // Paginate historic snapshots: PostgREST otherwise truncates at 1,000 rows.
      const snapshots:any[] = [];
      for (let offset=0;;offset+=1000) {
        const rows = await must(client.from("snapshots").select("source,date,rating,reviews,pv,visits,reservations").in("source",targets).order("id").range(offset,offset+999));
        snapshots.push(...rows);
        if (rows.length<1000) break;
      }
      const reviews:any[]=[];
      for(let offset=0;;offset+=1000) {
        const rows=await must(client.from('reviews').select('id,source,rating,text,author,sentiment,review_date,external_id,title,visit_month,details').in('source',targets).order('id').range(offset,offset+999));
        reviews.push(...rows); if(rows.length<1000) break;
      }
      // 取り込み済みの口コミ（source_reviews）は旧 reviews 表の同じ口コミIDより優先。一休は ikyu_reviews。
      const ingested=await loadSourceReviews(client,targets).catch(()=>[]);
      let merged=mergeReviews(reviews.map((r:any)=>({...r,rating:r.rating==null?null:Number(r.rating),date:r.review_date})),ingested);
      if(targets.includes("ikyu")) {
        // 一休: 管理画面の口コミ（ikyu_reviews）＋公開ページの口コミ（旧 reviews 表、PR #11 の取り込みを含む）。本文が同じ公開口コミは除く。
        const owner=await loadIkyuReviews(client).catch(()=>[]);
        merged=[...dropPublicDuplicates(merged,owner),...owner];
      }
      const logs=await must(client.from('sync_log').select('at').in('source',targets).in('status',['ok','partial']).order('at',{ascending:false}).limit(1));
      const dashboard=computeDashboard(snapshots,merged,logs[0]?.at??null,targets,false);
      let details:any=targets.includes("tabelog")?await loadDetails(client,"tabelog",dashboard.series[0]?.date):null;
      if(details && !details.unavailable) details=await loadIngestedDetails(client,"tabelog",dashboard.series[0]?.date).then((x)=>overlayDetails(details,x)).catch(()=>details);
      const ikyu=source==="ikyu"?await loadIkyuDetails(client,ikyuFromDate()):null;
      return json(req,{...dashboard,details,ikyu});
    }
    if (!user) return json(req,{error:"ログインが必要です"},401);
    if (path === "/credentials" && req.method === "GET") {
      const rows=await must(client.from("credentials").select(credentialColumns).order("updated_at",{ascending:false}));
      return json(req,rows.map((r:any)=>({id:r.id,source:r.source,label:r.label,storeKey:r.store_key,credentialsVersion:r.credentials_version,updatedAt:r.updated_at})));
    }
    if (path === "/credentials" && req.method === "POST") {
      const input=await body(req);
      const username = input.source === "ikyu" ? packIkyuUsername(input.storeId, input.username) : (typeof input.username === "string" ? input.username.trim() : "");
      // 店舗×サイトで1件。一休は店舗ID、他サイトは任意の店舗コード（未指定は''）
      const storeKey = input.source === "ikyu" ? String(input.storeId ?? "") : (typeof input.storeKey === "string" ? input.storeKey.trim() : "");
      if(!/^[0-9A-Za-z_-]{0,40}$/.test(storeKey)) return json(req,{error:"店舗コードは英数字・_・-の40文字以内で入力してください"},400);
      if(!getSource(input.source) || !username || username.length>320 || typeof input.password!=="string" || !input.password || input.password.length>1000 || (input.label && (typeof input.label!=="string" || input.label.length>200))) return json(req,{error:input.source==="ikyu"?"店舗ID（6桁）・オペレータID・パスワードをご確認ください":"サイト・ID・パスワードをご確認ください"},400);
      await must(admin.from("credentials").upsert({user_id:user.id,source:input.source,store_key:storeKey,label:input.label||"",username,password_enc:await encrypt(input.password),updated_at:new Date().toISOString()},{onConflict:"user_id,source,store_key"}));
      return json(req,{ok:true});
    }
    if (/^\/credentials\/[0-9a-f-]{36}$/.test(path) && req.method === "DELETE") {
      await must(admin.from("credentials").delete().eq("user_id",user.id).eq("id",path.split("/").at(-1)));
      return json(req,{ok:true});
    }
    // アプリ内の同期は廃止（すべてのサイトは Grok Bot が取り込む）。旧画面からの呼び出しには理由を返す。
    if (path === "/sync" || path.startsWith("/sync/")) return json(req,{error:"アプリからの同期は終了しました。「取得依頼」からGrok Botへ依頼してください"},410);
    // アプリ → Grok Bot の取得依頼。本人のJWTで登録・閲覧（RLS）。状態の変更は agent-api のみ。
    if (path === "/requests" && req.method === "GET") {
      const rows=await must(client.from("agent_requests").select(requestColumns).order("requested_at",{ascending:false}).limit(50));
      return json(req,{requests:rows.map((r:any)=>publicRequest(r))});
    }
    if (path === "/requests" && req.method === "POST") {
      let row;
      try { row=validateRequestInput(await body(req),japanDate().slice(0,7)); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const {data,error}=await client.from("agent_requests").insert(row).select(requestColumns).single();
      if(error?.code==="23505") return json(req,{error:"同じ店舗・サイト・内容の依頼が処理待ちです。完了までお待ちください"},409);
      if(error?.code==="P0429") return json(req,{error:error.message},429);
      if(error) throw error;
      return json(req,{request:publicRequest(data)},201);
    }
    // 自動取得の設定（店舗×サイト）。閲覧は本人のJWT（RLS）、保存は検証後に本人の user_id に限定して service_role で行う（credentials と同じ）。
    // 予定時刻を過ぎた設定を取得依頼にするのは agent-api /schedules/enqueue-due（Grok Bot）だけ。
    if (path === "/schedules" && req.method === "GET") {
      const rows=await must(client.from("fetch_schedules").select("*").order("source").order("store_id"));
      return json(req,{schedules:rows.map((r:any)=>publicSchedule(r))});
    }
    if (path === "/schedules" && req.method === "POST") {
      let row;
      try { row=validateScheduleInput(await body(req)); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const existing=await must(admin.from("fetch_schedules").select("last_enqueued_at").eq("user_id",user.id).eq("source",row.source).eq("store_id",row.store_id).limit(1));
      const now=new Date();
      const saved=await must(admin.from("fetch_schedules").upsert({...row,user_id:user.id,next_due_at:nextDueOnSave(row,now,existing[0]?.last_enqueued_at??null),
        updated_at:now.toISOString(),updated_by:user.id},{onConflict:"user_id,source,store_id"}).select("*").single());
      return json(req,{schedule:publicSchedule(saved)});
    }
    if (/^\/schedules\/[0-9a-f-]{36}$/.test(path) && req.method === "DELETE") {
      await must(admin.from("fetch_schedules").delete().eq("user_id",user.id).eq("id",path.split("/").at(-1)));
      return json(req,{ok:true});
    }
    return json(req,{error:"ページが見つかりません"},404);
  } catch {
    // Do not expose SQL errors, tokens, or credential inputs in public logs.
    return json(req,{error:"処理を完了できませんでした。時間をおいて再度お試しください"},500);
  }
});
