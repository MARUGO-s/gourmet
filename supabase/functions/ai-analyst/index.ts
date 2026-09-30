// AI分析（OpenAI）。利用者の認証は review-api と同じ（Authorization の Supabase JWT を auth.getUser で検証）。
// データの読み込みは本人のJWTのクライアント（RLS・SELECTのみ）。保存（ai_reports・ai_usage）は検証後に本人の user_id に限定して service_role。
// モデルは AI_TOOLS の関数だけを呼べ、SQLや表名は受け取らない。OPENAI_API_KEY はブラウザ・応答・ログへ出さない。
// M-talk 送信（/mtalk-recipients, /reports/:id/share-mtalk, /shares）: ログイン中の利用者が自分のレポートを、M-talk の
// 有効な利用者1人へ「AI分析」Botのカード＋PDFで送る。PDFはここで作る（Noto Sans JP を埋め込み）。
// GOURMET_MTALK_TOKEN・MTALK_API_URL は秘密情報。ブラウザ・応答・ログ・エラーへ出さない。送信は毎回 ai_report_shares に記録する。
// M-talk からの質問（POST /mtalk-chat）: 呼び出し元は line_report の mtalk-external-post だけ（JWTではなく GOURMET_MTALK_TOKEN + HMAC 署名）。
// 「AI分析」Bot との1対1での質問に、/ask と同じモデル・同じ関数で答える。データの持ち主は mtalk-chat.js の resolveDataOwner で決め、
// その user_id で絞った SELECT だけで読む。回数は ai_usage（kind='mtalk'、mtalk_user_id ごとに1時間60回）。
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import * as PDFLib from "npm:pdf-lib@1.17.1";
import * as fontkit from "npm:fontkit@2.0.4";
import { service, json, body } from "../_shared/http.ts";
import { must, japanDate } from "../_shared/sync-data.js";
import { AI_LIMITS, REPORT_SCHEMA_HINT, buildReportFacts, composeReportMarkdown, contextMessage, normalizeReportAi, reportPromptFacts, resolvePeriod, systemPrompt,
  validateAskInput, validateReportInput } from "../_shared/ai-analyst.js";
import { AiError, answerWithTools, chatCompletion, openAiConfig } from "../_shared/openai.js";
import { loadAnalystDataset } from "../_shared/ai-data.js";
import { MTALK_SHARE_LIMITS, MtalkError, buildShareCard, bytesToBase64, mtalkConfig, mtalkRequest, normalizeRecipients, publicShare, senderLabel,
  shareFileName, validateShareInput } from "../_shared/mtalk-share.js";
import { loadReportFonts, renderReportPdf } from "../_shared/report-pdf.js";
import { MTALK_CHAT_LIMITS, MTALK_CHAT_PATH, MtalkChatError, mtalkChatPrompt, reportContextMessage, resolveDataOwner, scopedReadClient, splitReply,
  toMtalkPlainText, validateMtalkChatInput, verifyMtalkRequest } from "../_shared/mtalk-chat.js";
import * as fontModule from "../_shared/fonts/noto-sans-jp.js";

const reportPath = /^\/reports\/([0-9a-f-]{36})$/;
const listColumns = "id,title,store_id,store_name,period_from,period_to,model,created_at";
const sharePath = /^\/reports\/([0-9a-f-]{36})\/share-mtalk$/;
const shareColumns = "id,report_id,report_title,recipient_user_id,recipient_name,status,error,created_at,sent_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let fontCache: Promise<{ regular: Uint8Array; bold: Uint8Array }> | null = null;
const reportFonts = () => (fontCache ??= loadReportFonts(fontModule).catch((e) => { fontCache = null; throw e; }));
const jstNow = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

Deno.serve(async req => {
  if (req.method === "OPTIONS") return json(req, {});
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/ai-analyst/, "") || "/";
  const admin = service();
  if (path === MTALK_CHAT_PATH) return await mtalkChat(req, admin);
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return json(req, { error:"ログインが必要です" }, 401);
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return json(req, { error:"ログインし直してください" }, 401);
  const user = auth.user;
  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization:`Bearer ${token}` } }, auth:{persistSession:false,autoRefreshToken:false},
  });
  const config = openAiConfig((k: string) => Deno.env.get(k));
  const today = japanDate();
  // 1時間あたりの利用回数（本人の ai_usage）
  const overLimit = async (kind: "ask" | "report") => {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count, error } = await admin.from("ai_usage").select("id", { count:"exact", head:true }).eq("user_id", user.id).eq("kind", kind).gte("created_at", since);
    if (error) throw error;
    return (count ?? 0) >= (kind === "ask" ? AI_LIMITS.askPerHour : AI_LIMITS.reportsPerHour);
  };
  const logUsage = (kind: "ask" | "report", model: string, usage: any) => admin.from("ai_usage").insert({ user_id:user.id, kind, model:String(model).slice(0, 100),
    prompt_tokens:usage?.prompt_tokens ?? null, completion_tokens:usage?.completion_tokens ?? null }).then(({ error }) => { if (error) console.warn("[ai-analyst] usage log failed"); });

  try {
    if (path === "/status" && req.method === "GET") return json(req, { configured:!!config.apiKey, model:config.model, limits:{ askPerHour:AI_LIMITS.askPerHour, reportsPerHour:AI_LIMITS.reportsPerHour } });

    if (path === "/ask" && req.method === "POST") {
      let input;
      try { input = validateAskInput(await body(req, 200_000), today); }
      catch (error) { return json(req, { error:(error as Error).message }, 400); }
      if (!config.apiKey) return json(req, { error:"AI分析は未設定です（管理者がサーバーに OPENAI_API_KEY を設定すると利用できます）" }, 503);
      if (await overLimit("ask")) return json(req, { error:`質問は1時間に${AI_LIMITS.askPerHour}回までです。しばらくしてからお試しください` }, 429);
      const ds = await loadAnalystDataset(client, { today });
      if (input.store !== "all" && !ds.stores.some((s: any) => s.id === input.store)) return json(req, { error:"店舗が見つかりません。店舗を選び直してください" }, 404);
      const messages = [
        { role:"system", content:systemPrompt(today) },
        { role:"system", content:contextMessage(ds, input) },
        ...input.history,
        { role:"user", content:input.question },
      ];
      const result = await answerWithTools(config, { ds, messages, ctx:{ store:input.store, from:input.from, to:input.to } });
      await logUsage("ask", result.model, result.usage);
      return json(req, { answer:result.answer, model:result.model, calls:result.calls, period:{ from:input.from, to:input.to }, store:input.store });
    }

    if (path === "/reports" && req.method === "GET") {
      const rows = await must(client.from("ai_reports").select(listColumns).order("created_at", { ascending:false }).limit(100));
      return json(req, { reports:rows.map(publicReport) });
    }
    if (reportPath.test(path) && req.method === "GET") {
      const rows = await must(client.from("ai_reports").select(`${listColumns},markdown,content`).eq("id", path.split("/")[2]).limit(1));
      if (!rows.length) return json(req, { error:"レポートが見つかりません" }, 404);
      return json(req, { report:{ ...publicReport(rows[0]), markdown:rows[0].markdown, content:rows[0].content } });
    }
    if (reportPath.test(path) && req.method === "DELETE") {
      await must(admin.from("ai_reports").delete().eq("user_id", user.id).eq("id", path.split("/")[2]));
      return json(req, { ok:true });
    }
    if (path === "/reports" && req.method === "POST") {
      let input;
      try { input = validateReportInput(await body(req, 20_000), today); }
      catch (error) { return json(req, { error:(error as Error).message }, 400); }
      if (!config.apiKey) return json(req, { error:"AI分析は未設定です（管理者がサーバーに OPENAI_API_KEY を設定すると利用できます）" }, 503);
      if (await overLimit("report")) return json(req, { error:`レポートは1時間に${AI_LIMITS.reportsPerHour}件まで作成できます。しばらくしてからお試しください` }, 429);
      const ds = await loadAnalystDataset(client, { today });
      if (input.store !== "all" && !ds.stores.some((s: any) => s.id === input.store)) return json(req, { error:"店舗が見つかりません。店舗を選び直してください" }, 404);
      const facts = buildReportFacts(ds, input);
      const r = await chatCompletion(config, {
        messages: [
          { role:"system", content:`${systemPrompt(today)}\n\nこれから渡す集計データ（JSON）だけに基づいて、分析レポートの文章を書きます。数値の表はシステムが別に作成するため、文章では重要な数値だけを引用してください。${REPORT_SCHEMA_HINT}` },
          { role:"user", content:`${input.focus ? `特に知りたいこと: ${input.focus}\n\n` : ""}集計データ:\n${reportPromptFacts(facts)}` },
        ],
        response_format:{ type:"json_object" }, max_completion_tokens:12000,
      }, { timeoutMs:140_000 });
      if (!r.message.content) throw new AiError(r.finishReason === "length" ? "AIの出力が上限に達しました。期間を短くしてお試しください" : "AIからレポートが得られませんでした", 502);
      const ai = normalizeReportAi(r.message.content);
      const title = input.title || ai.title || `${facts.store.name} 分析レポート（${input.from}〜${input.to}）`;
      const markdown = composeReportMarkdown(facts, ai, { title, model:r.model });
      await logUsage("report", r.model, r.usage);
      const saved = await must(admin.from("ai_reports").insert({
        user_id:user.id, store_id:input.store === "all" ? null : input.store, store_name:facts.store.name, period_from:input.from, period_to:input.to,
        title:title.slice(0, 200), markdown, content:{ version:1, facts, ai, focus:input.focus || null }, model:String(r.model).slice(0, 100),
      }).select(`${listColumns},markdown,content`).single());
      return json(req, { report:{ ...publicReport(saved), markdown:saved.markdown, content:saved.content } }, 201);
    }

    // ---------- M-talk 送信 ----------
    const mtalk = mtalkConfig((k: string) => Deno.env.get(k));
    if (path === "/mtalk-recipients" && req.method === "GET") {
      const data = await mtalkRequest(mtalk, "GET", "/recipients", null);
      return json(req, { recipients:normalizeRecipients(data) });
    }
    if (path === "/shares" && req.method === "GET") {
      const reportId = url.searchParams.get("reportId");
      if (reportId && !UUID.test(reportId)) return json(req, { error:"レポートIDが不正です" }, 400);
      let q = client.from("ai_report_shares").select(shareColumns).eq("user_id", user.id).order("created_at", { ascending:false }).limit(50);
      if (reportId) q = q.eq("report_id", reportId);
      const rows = await must(q);
      return json(req, { shares:rows.map(publicShare), configured:mtalk.configured, limits:{ perHour:MTALK_SHARE_LIMITS.perHour } });
    }
    if (sharePath.test(path) && req.method === "POST") {
      let input;
      try { input = validateShareInput(await body(req, 2_000)); }
      catch (error) { return json(req, { error:error instanceof SyntaxError ? "送信内容が不正です" : (error as Error).message }, 400); }
      if (!mtalk.configured) return json(req, { error:"M-talk連携は未設定です（管理者がサーバーに接続情報を設定すると利用できます）" }, 503);
      const since = new Date(Date.now() - 3600_000).toISOString();
      const { count, error:countError } = await admin.from("ai_report_shares").select("id", { count:"exact", head:true }).eq("user_id", user.id).gte("created_at", since);
      if (countError) throw countError;
      if ((count ?? 0) >= MTALK_SHARE_LIMITS.perHour) return json(req, { error:`M-talkへの送信は1時間に${MTALK_SHARE_LIMITS.perHour}件までです。しばらくしてからお試しください` }, 429);
      // 本人のレポートだけ（RLSに加えて user_id でも絞る）
      const reportId = path.split("/")[2];
      const rows = await must(client.from("ai_reports").select(`${listColumns},markdown,content`).eq("id", reportId).eq("user_id", user.id).limit(1));
      if (!rows.length) return json(req, { error:"レポートが見つかりません" }, 404);
      const report = { ...publicReport(rows[0]), markdown:rows[0].markdown, content:rows[0].content };
      const recipient = normalizeRecipients(await mtalkRequest(mtalk, "GET", "/recipients", null)).find((r: { id: string }) => r.id === input.recipientUserId) as { id: string; username: string } | undefined;
      if (!recipient) return json(req, { error:"送信先のM-talk利用者が見つからないか、利用停止中です。送信先を選び直してください" }, 404);
      const sender = senderLabel(user);
      const share = await must(admin.from("ai_report_shares").insert({
        user_id:user.id, report_id:report.id, report_title:String(report.title).slice(0, 200), recipient_user_id:recipient.id,
        recipient_name:recipient.username.slice(0, 200), sender_label:sender, status:"pending",
      }).select("id").single());
      try {
        const pdf = await renderReportPdf({ PDFLib, fontkit, fonts:await reportFonts(), report,
          meta:[`送信者: ${sender}`, `送信先: ${recipient.username}（M-talk）`, `PDF出力: ${jstNow()}（日本時間）`] });
        if (pdf.byteLength > MTALK_SHARE_LIMITS.pdfMaxBytes) throw new MtalkError("PDFが大きすぎるため送信できませんでした", 413);
        const card = buildShareCard(report, { sender });
        const sent = await mtalkRequest(mtalk, "POST", "/send", {
          recipient_user_id:recipient.id, report_id:report.id, ...card, pdf_base64:bytesToBase64(pdf), filename:shareFileName(report), dedupe_key:`gourmet:${share.id}`,
        });
        const saved = await must(admin.from("ai_report_shares").update({
          status:"sent", sent_at:new Date().toISOString(), pdf_bytes:pdf.byteLength, error:null,
          mtalk_group_id:Number(sent.group_id) || null, mtalk_card_message_id:Number(sent.card_message_id) || null, mtalk_file_message_id:Number(sent.file_message_id) || null,
        }).eq("id", share.id).eq("user_id", user.id).select(shareColumns).single());
        return json(req, { share:publicShare(saved) }, 201);
      } catch (error) {
        const message = error instanceof MtalkError ? error.message : "M-talkへの送信を完了できませんでした";
        await admin.from("ai_report_shares").update({ status:"failed", error:message.slice(0, 300) }).eq("id", share.id).eq("user_id", user.id)
          .then(({ error:e }) => { if (e) console.warn("[ai-analyst] share log failed"); });
        throw error;
      }
    }
    return json(req, { error:"ページが見つかりません" }, 404);
  } catch (error) {
    if (error instanceof MtalkError) return json(req, { error:error.message }, error.status);
    if (error instanceof AiError) return json(req, { error:error.message }, (error as AiError & { status: number }).status);
    // SQLエラー・APIキー・入力をログや応答に出さない
    console.warn("[ai-analyst] failed");
    return json(req, { error:"処理を完了できませんでした。時間をおいて再度お試しください" }, 500);
  }
});

// ---------- M-talk からの質問（line_report → gourmet、サーバー間のみ。CORS なし） ----------
const plainJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers:{ "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" } });

async function mtalkChat(req: Request, admin: ReturnType<typeof service>): Promise<Response> {
  if (req.method !== "POST") return plainJson({ error:"method not allowed" }, 405);
  const bodyText = await req.text();
  if (bodyText.length > 100_000) return plainJson({ error:"送信内容が大きすぎます" }, 413);
  const authorized = await verifyMtalkRequest({
    authorization:req.headers.get("authorization"), timestamp:req.headers.get("x-mtalk-timestamp"), signature:req.headers.get("x-mtalk-signature"),
    method:"POST", path:MTALK_CHAT_PATH, body:bodyText,
  }, Deno.env.get("GOURMET_MTALK_TOKEN") ?? "");
  if (!authorized) return plainJson({ error:"unauthorized" }, 401);
  try {
    let input;
    try { input = validateMtalkChatInput(JSON.parse(bodyText)); }
    catch (error) { return plainJson({ error:error instanceof MtalkChatError ? error.message : "入力形式が不正です" }, 400); }
    const config = openAiConfig((k: string) => Deno.env.get(k));
    if (!config.apiKey) return plainJson({ error:"AI分析は現在準備中です（管理者の設定待ち）。しばらくしてからお試しください" }, 503);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count, error:countError } = await admin.from("ai_usage").select("id", { count:"exact", head:true })
      .eq("kind", "mtalk").eq("mtalk_user_id", input.mtalkUserId).gte("created_at", since);
    if (countError) throw countError;
    if ((count ?? 0) >= MTALK_CHAT_LIMITS.perHour) return plainJson({ error:`質問は1時間に${MTALK_CHAT_LIMITS.perHour}回までです。しばらくしてからお試しください` }, 429);

    // データの持ち主: このトークへ最後にレポートを送った gourmet 利用者 → 無ければ INGEST_USER_ID
    const { data:shares, error:shareError } = await admin.from("ai_report_shares").select("user_id,report_id,sent_at")
      .eq("recipient_user_id", input.mtalkUserId).eq("mtalk_group_id", input.groupId).eq("status", "sent")
      .order("sent_at", { ascending:false }).limit(1);
    if (shareError) throw shareError;
    const owner = resolveDataOwner(shares?.[0] ?? null, Deno.env.get("INGEST_USER_ID") ?? "");
    if (!owner) return plainJson({ error:"分析できるデータがまだありません。Review Command Center からレポートを送ってもらってから質問してください" }, 404);
    let report: any = null;
    if (owner.reportId) {
      const { data, error } = await admin.from("ai_reports").select("id,title,store_id,store_name,period_from,period_to,markdown")
        .eq("id", owner.reportId).eq("user_id", owner.userId).limit(1);
      if (error) throw error;
      report = data?.[0] ?? null;
    }
    const today = japanDate();
    const ds = await loadAnalystDataset(scopedReadClient(admin, owner.userId), { today });
    const store = report?.store_id && ds.stores.some((s: any) => s.id === report.store_id) ? report.store_id : "all";
    const period = report ? { from:String(report.period_from).slice(0, 10), to:String(report.period_to).slice(0, 10) } : resolvePeriod(null, null, today);
    const ask = { store, ...period };
    const reportMessage = reportContextMessage(report);
    const messages = [
      { role:"system", content:systemPrompt(today) },
      { role:"system", content:mtalkChatPrompt() },
      { role:"system", content:contextMessage(ds, ask) },
      ...(reportMessage ? [{ role:"system", content:reportMessage }] : []),
      ...input.history,
      { role:"user", content:input.question },
    ];
    const result: any = await answerWithTools(config, { ds, messages, ctx:ask, maxTokens:4000 });
    await admin.from("ai_usage").insert({ user_id:owner.userId, kind:"mtalk", mtalk_user_id:input.mtalkUserId, model:String(result.model).slice(0, 100),
      prompt_tokens:result.usage?.prompt_tokens ?? null, completion_tokens:result.usage?.completion_tokens ?? null })
      .then(({ error }) => { if (error) console.warn("[ai-analyst] mtalk usage log failed"); });
    const parts = splitReply(toMtalkPlainText(result.answer));
    if (!parts.length) return plainJson({ error:"AIから回答が得られませんでした。質問を変えてお試しください" }, 502);
    return plainJson({ parts, model:result.model, calls:result.calls.length, owner:owner.via, report:report ? { id:report.id, title:report.title } : null });
  } catch (error) {
    if (error instanceof AiError) return plainJson({ error:error.message }, (error as AiError & { status: number }).status);
    console.warn("[ai-analyst] mtalk-chat failed");
    return plainJson({ error:"処理を完了できませんでした。時間をおいて再度お試しください" }, 500);
  }
}

function publicReport(r: any) {
  return { id:r.id, title:r.title, storeId:r.store_id ?? "all", storeName:r.store_name, from:r.period_from, to:r.period_to, model:r.model, createdAt:r.created_at };
}
