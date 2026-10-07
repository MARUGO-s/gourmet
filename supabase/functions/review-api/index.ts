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
import { publicWeeklySchedule, validateWeeklyScheduleInput, weeklySchedulePatchOnSave } from "../_shared/weekly-schedules.js";
import { ALL_STORES, UNASSIGNED, MAX_STORES, buildOverview, filterReviews, isMonth, isStoreId, publicSite, publicStores, scopeKeys, storeSnapshots,
  validateReorder, validateSiteInput, validateStoreInput } from "../_shared/stores.js";
import { loadOverviewInputs, loadStoreDailyInputs, loadStoreMaster } from "../_shared/store-data.js";
import { STORE_BOTS_PATH, normalizeStoreBots, publicAlertEvent, publicAlertSettings, publicDelivery, validateAlertSettingsInput } from "../_shared/review-alerts.js";
import { mtalkConfig, mtalkRequest } from "../_shared/mtalk-share.js";
import { queueRefetchAfterSave } from "../_shared/mtalk-followups.js";
import { isUuid } from "../_shared/login-help.js";
import { userManagement, viewingAccess } from "../_shared/user-management.js";

// M-talk の店舗Bot（と参加しているグループのルーム）。読めなければ bots=null と理由（画面は保存済みの設定だけ出す）
async function loadStoreBots(): Promise<{ bots: any[] | null; botsError: string | null }> {
  try {
    return { bots: normalizeStoreBots(await mtalkRequest(mtalkConfig((k: string) => Deno.env.get(k)), "GET", STORE_BOTS_PATH, null, { timeoutMs: 15_000 })), botsError: null };
  } catch (error) {
    return { bots: null, botsError: (error as Error).message || "M-talk の店舗Botを読み込めませんでした" };
  }
}

const demo = buildSeed();
// ログインID・暗号文はブラウザへ返さない（登録済み・更新日時のみ）
const credentialColumns = "id,source,label,store_key,credentials_version,updated_at";
const ikyuDemo = buildIkyuDemo();
// 一休の前年比には前年同月の日別値が必要なため、前年同月1日以降を読む
const ikyuFromDate = () => { const d = new Date(Date.now() + 9 * 3600_000); return `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`; };
// 店舗に食べログが割り当てられていない（旧データも含まない）ときの詳細の土台
const emptyDetails = () => ({ ranking:null, topPages:null, monthly:[], ownerReviews:null, pageHistory:null, deviceDaily:{} });
const storePath = /^\/stores\/([0-9a-f-]{36})$/;
const sitePath = /^\/stores\/([0-9a-f-]{36})\/sites$/;
const siteItemPath = /^\/stores\/([0-9a-f-]{36})\/sites\/([0-9a-f-]{36})$/;
const requestColumns = "id,source,store_id,action,params,status,requested_at,claimed_at,finished_at,claimed_by,attempts,result,error,failure_kind";

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
    if (path === "/me" || path === "/users" || path.startsWith("/users/")) {
      if (!user) return json(req, { error: "ログインが必要です" }, 401);
      let input = null;
      if (["/users/admin", "/users/access", "/users/delete"].includes(path) && req.method === "POST") {
        try { input = await body(req, 12000); }
        catch { return json(req, { error: "ユーザーと権限の指定が不正です" }, 400); }
      }
      const result = await userManagement(client, path, req.method, input, new URL(req.url).searchParams.get("page") ?? "1");
      return json(req, result.data, result.status);
    }
    let isAdmin = false;
    if (user) {
      const denied = await viewingAccess(client);
      if (denied) return json(req, denied.data, denied.status);
      isAdmin = await must(client.rpc("gourmet_is_admin"));
      if (!isAdmin && (req.method !== "GET" || !["/sources", "/dashboard", "/overview", "/stores"].includes(path))) {
        return json(req, { error: "この操作は管理者のみ利用できます" }, 403);
      }
    }
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
      // 店舗の選択（'all'＝全店舗、店舗ID、'unassigned'＝どの店舗にも割り当てていない店舗コード）。表示の絞り込みのみ。
      const scope = new URL(req.url).searchParams.get("store") || ALL_STORES;
      if (scope !== ALL_STORES && scope !== UNASSIGNED && !isStoreId(scope)) return json(req,{error:"店舗の指定が不正です"},400);
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
      if (scope !== ALL_STORES || !isAdmin || snapshots.length === 0) {
        // 店舗単位: 店舗コードのある取り込み行から集計し、旧データ（店舗コードなし）は既定の店舗コード '' として扱う（stores.js）
        const master=await loadStoreMaster(client);
        if (isStoreId(scope) && !master.stores.some((s:any)=>s.id===scope)) return json(req,{error:"店舗が見つかりません。店舗を選び直してください"},404);
        const inputs=await loadStoreDailyInputs(client,targets);
        const observed=[...inputs.daily,...inputs.monthly].map((r:any)=>({source:r.source,key:r.key}))
          .concat(snapshots.filter((s:any)=>s.source!=="ikyu").map((s:any)=>({source:s.source,key:""})))
          .concat(merged.map((r:any)=>({source:r.source,key:String(r.details?.storeId ?? "")})));
        const keys=scope === ALL_STORES ? Object.fromEntries(SOURCE_IDS.map(s => [s, new Set(master.sites.filter((x:any) => x.source === s).map((x:any) => x.site_store_key as string))])) : scopeKeys(scope,master.sites,observed)!;
        const rows=storeSnapshots({targets,keys,daily:inputs.daily,monthly:inputs.monthly,legacy:snapshots.filter((s:any)=>s.source!=="ikyu")});
        const dashboard=computeDashboard(rows,filterReviews(merged,keys),logs[0]?.at??null,targets,false);
        const tabelogKeys:Set<string>|undefined=keys.tabelog;
        let details:any=null;
        if (targets.includes("tabelog") && tabelogKeys?.size) {
          details=tabelogKeys.has("")?await loadDetails(client,"tabelog",dashboard.series[0]?.date):emptyDetails();
          if(!details.unavailable) details=await loadIngestedDetails(client,"tabelog",dashboard.series[0]?.date)
            .then((x:any)=>overlayDetails(details,{daily:x.daily.filter((r:any)=>tabelogKeys.has(r.store_key)),monthly:x.monthly.filter((r:any)=>tabelogKeys.has(r.store_key)),reports:x.reports.filter((r:any)=>tabelogKeys.has(r.store_key))}))
            .catch(()=>details);
        }
        let ikyu:any=source==="ikyu"?await loadIkyuDetails(client,ikyuFromDate()):null;
        if (ikyu && !ikyu.unavailable) {
          const ids:Set<string>=keys.ikyu ?? new Set();
          ikyu={...ikyu,stores:ikyu.stores.filter((s:any)=>ids.has(s.storeId)),months:ikyu.months.filter((m:any)=>ids.has(m.storeId)),daily:ikyu.daily.filter((d:any)=>ids.has(d.storeId))};
        }
        return json(req,{...dashboard,details,ikyu,store:scope});
      }
      const dashboard=computeDashboard(snapshots,merged,logs[0]?.at??null,targets,false);
      let details:any=targets.includes("tabelog")?await loadDetails(client,"tabelog",dashboard.series[0]?.date):null;
      if(details && !details.unavailable) details=await loadIngestedDetails(client,"tabelog",dashboard.series[0]?.date).then((x)=>overlayDetails(details,x)).catch(()=>details);
      const ikyu=source==="ikyu"?await loadIkyuDetails(client,ikyuFromDate()):null;
      return json(req,{...dashboard,details,ikyu,store:ALL_STORES});
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
      if(input.retry!=null && !isUuid(input.retry)) return json(req,{error:"取り直す依頼が不正です"},400);
      await must(admin.from("credentials").upsert({user_id:user.id,source:input.source,store_key:storeKey,label:input.label||"",username,password_enc:await encrypt(input.password),updated_at:new Date().toISOString()},{onConflict:"user_id,source,store_key"}));
      // 保存したら、その店舗×サイトの取り直しを依頼する（M-talk のボタンから来たなら結果をそのトークへ）。依頼できなくても保存は成功
      let refetch;
      try { refetch=await queueRefetchAfterSave(admin,user.id,{source:input.source,storeKey,retry:input.retry??null}); }
      catch { refetch={status:"failed",mtalk:false,message:"取り直しを依頼できませんでした。「取得依頼」から依頼してください"}; }
      return json(req,{ok:true,refetch});
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
    // 週報の配信予定（店舗ごとの曜日・時刻・ルーム）。閲覧は本人のJWT（RLS）、保存は検証後に本人の user_id に限定して service_role。
    // 予定時刻を過ぎた店舗の週報を作って届けるのは Grok Bot（agent-api /weekly/due → /weekly/claim → /weekly/deliver → /weekly/finish）だけ。
    if (path === "/weekly-schedules" && req.method === "GET") {
      const [rows, stores]=await Promise.all([
        must(client.from("weekly_delivery_schedules").select("*")),
        must(client.from("stores").select("id,name")),
      ]);
      const byId=new Map(stores.map((s:any)=>[s.id,s]));
      return json(req,{schedules:rows.map((r:any)=>publicWeeklySchedule(r,byId.get(r.store_id) as any))});
    }
    if (path === "/weekly-schedules" && req.method === "POST") {
      const stores=await must(admin.from("stores").select("id,name").eq("user_id",user.id));
      let row;
      try { row=validateWeeklyScheduleInput(await body(req),stores.map((s:any)=>s.id)); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const now=new Date();
      const saved=await must(admin.from("weekly_delivery_schedules").upsert({...row,...weeklySchedulePatchOnSave(row,now),user_id:user.id,
        updated_at:now.toISOString(),updated_by:user.id},{onConflict:"user_id,store_id"}).select("*").single());
      return json(req,{schedule:publicWeeklySchedule(saved,stores.find((s:any)=>s.id===saved.store_id) as any)});
    }
    if (/^\/weekly-schedules\/[0-9a-f-]{36}$/.test(path) && req.method === "DELETE") {
      await must(admin.from("weekly_delivery_schedules").delete().eq("user_id",user.id).eq("id",path.split("/").at(-1)));
      return json(req,{ok:true});
    }
    // 店舗マスタ（店舗ごとに各サイトの店舗IDをまとめる）。閲覧は本人のJWT（RLS）、保存は検証後に本人の user_id に限定して service_role。
    if (path === "/stores" && req.method === "GET") {
      const { stores, sites } = await loadStoreMaster(client);
      return json(req,{stores:publicStores(stores,sites)});
    }
    if (path === "/stores" && req.method === "POST") {
      let row;
      try { row=validateStoreInput(await body(req)); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const existing=await must(admin.from("stores").select("sort_order").eq("user_id",user.id).order("sort_order",{ascending:false}).limit(MAX_STORES));
      if (existing.length>=MAX_STORES) return json(req,{error:`店舗は${MAX_STORES}件までです`},409);
      const {data,error}=await admin.from("stores").insert({user_id:user.id,name:row.name,sort_order:row.sort_order ?? ((existing[0]?.sort_order ?? 0)+1)}).select("id,name,sort_order,updated_at").single();
      if (error?.code==="23505") return json(req,{error:"同じ名前の店舗があります"},409);
      if (error) throw error;
      return json(req,{store:publicStores([data],[])[0]},201);
    }
    if (path === "/stores/reorder" && req.method === "POST") {
      const existing=await must(admin.from("stores").select("id").eq("user_id",user.id));
      let order;
      try { order=validateReorder(await body(req),existing.map((s:any)=>s.id)); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const now=new Date().toISOString();
      for (const o of order) await must(admin.from("stores").update({sort_order:o.sort_order,updated_at:now}).eq("user_id",user.id).eq("id",o.id));
      const { stores, sites } = await loadStoreMaster(client);
      return json(req,{stores:publicStores(stores,sites)});
    }
    if (storePath.test(path) && req.method === "POST") {
      let row;
      try { row=validateStoreInput(await body(req),{partial:true}); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const {data,error}=await admin.from("stores").update({...row,updated_at:new Date().toISOString()}).eq("user_id",user.id).eq("id",path.split("/")[2]).select("id,name,sort_order,updated_at");
      if (error?.code==="23505") return json(req,{error:"同じ名前の店舗があります"},409);
      if (error) throw error;
      if (!data?.length) return json(req,{error:"店舗が見つかりません"},404);
      const sites=await must(client.from("store_sites").select("id,store_id,source,site_store_key").eq("store_id",data[0].id));
      return json(req,{store:publicStores(data,sites)[0]});
    }
    // 店舗の削除: 店舗とサイトの割り当てだけを削除（資格情報・取得依頼・自動取得の設定・取り込みデータは残り、「未割り当て」に表示される）
    if (storePath.test(path) && req.method === "DELETE") {
      await must(admin.from("stores").delete().eq("user_id",user.id).eq("id",path.split("/")[2]));
      return json(req,{ok:true});
    }
    if (sitePath.test(path) && req.method === "POST") {
      const storeId=path.split("/")[2];
      let row;
      try { row=validateSiteInput(await body(req)); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const owned=await must(admin.from("stores").select("id").eq("user_id",user.id).eq("id",storeId).limit(1));
      if (!owned.length) return json(req,{error:"店舗が見つかりません"},404);
      const {data,error}=await admin.from("store_sites").insert({user_id:user.id,store_id:storeId,source:row.source,site_store_key:row.site_store_key}).select("id,store_id,source,site_store_key").single();
      if (error?.code==="23505") {
        const other=await must(admin.from("store_sites").select("id,store_id,source,site_store_key").eq("user_id",user.id).eq("source",row.source).eq("site_store_key",row.site_store_key).limit(1));
        if (other[0]?.store_id===storeId) return json(req,{site:publicSite(other[0])});
        const owner=other[0]?await must(admin.from("stores").select("name").eq("user_id",user.id).eq("id",other[0].store_id).limit(1)):[];
        return json(req,{error:`この店舗IDは「${owner[0]?.name ?? "別の店舗"}」に割り当て済みです`},409);
      }
      if (error) throw error;
      return json(req,{site:publicSite(data)},201);
    }
    if (siteItemPath.test(path) && req.method === "DELETE") {
      const [, , storeId, , siteId]=path.split("/");
      await must(admin.from("store_sites").delete().eq("user_id",user.id).eq("store_id",storeId).eq("id",siteId));
      return json(req,{ok:true});
    }
    // 口コミ通知（新着口コミ・総合点の変化 → M-talk）の店舗ごとの設定と履歴。閲覧は本人のJWT（RLS）、保存は検証後に本人の user_id に限定して service_role。
    // 送信は agent-api（取り込みの直後）。設定の無い店舗は既定（両方オン・店舗Botは店舗名で自動判定）。
    if (path === "/alert-settings" && req.method === "GET") {
      const [stores, rows, { bots, botsError }]=await Promise.all([
        must(client.from("stores").select("id,name,sort_order").order("sort_order").order("name")),
        must(client.from("review_alert_settings").select("*")),
        loadStoreBots(),
      ]);
      return json(req,{settings:publicAlertSettings(stores,rows,bots),bots,botsError,defaults:{botMode:"auto",newReviews:true,scoreChanges:true}});
    }
    if (path === "/alert-settings" && req.method === "POST") {
      const stores=await must(admin.from("stores").select("id,name").eq("user_id",user.id));
      let row;
      try { row=validateAlertSettingsInput(await body(req),stores.map((s:any)=>s.id)); }
      catch (error) { return json(req,{error:(error as Error).message},400); }
      const saved=await must(admin.from("review_alert_settings").upsert({...row,user_id:user.id,updated_at:new Date().toISOString(),updated_by:user.id},{onConflict:"user_id,store_id"}).select("*").single());
      const { bots }=await loadStoreBots();
      return json(req,{setting:publicAlertSettings(stores.filter((s:any)=>s.id===row.store_id),[saved],bots)[0]});
    }
    if (path === "/alert-log" && req.method === "GET") {
      const [deliveries, events]=await Promise.all([
        must(client.from("review_alert_deliveries").select("*").order("created_at",{ascending:false}).limit(50)),
        must(client.from("review_alert_events").select("id,kind,source,store_key,status,reason,payload,created_at,sent_at").neq("status","baseline").order("created_at",{ascending:false}).limit(50)),
      ]);
      return json(req,{deliveries:deliveries.map(publicDelivery),events:events.map(publicAlertEvent)});
    }
    // 全店舗の比較（店舗×サイトの月別PV・前月比・予約・評価・口コミ数・未返信・最終更新）。未割り当ての店舗コードは「未割り当て」にまとめる。
    if (path === "/overview" && req.method === "GET") {
      const month=new URL(req.url).searchParams.get("month");
      if (month && !isMonth(month)) return json(req,{error:"月の指定が不正です（YYYY-MM）"},400);
      const [{ stores, sites }, inputs]=await Promise.all([loadStoreMaster(client),loadOverviewInputs(client,{requestedMonth:month})]);
      return json(req,{overview:buildOverview({stores,sites,...inputs,month})});
    }
    return json(req,{error:"ページが見つかりません"},404);
  } catch {
    // Do not expose SQL errors, tokens, or credential inputs in public logs.
    return json(req,{error:"処理を完了できませんでした。時間をおいて再度お試しください"},500);
  }
});
