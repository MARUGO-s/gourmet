// AI分析（OpenAI）。利用者の認証は review-api と同じ（Authorization の Supabase JWT を auth.getUser で検証）。
// データの読み込みは本人のJWTのクライアント（RLS・SELECTのみ）。保存（ai_reports・ai_usage）は検証後に本人の user_id に限定して service_role。
// モデルは AI_TOOLS の関数だけを呼べ、SQLや表名は受け取らない。OPENAI_API_KEY はブラウザ・応答・ログへ出さない。
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { service, json, body } from "../_shared/http.ts";
import { must, japanDate } from "../_shared/sync-data.js";
import { AI_LIMITS, REPORT_SCHEMA_HINT, buildReportFacts, composeReportMarkdown, contextMessage, normalizeReportAi, reportPromptFacts, systemPrompt,
  validateAskInput, validateReportInput } from "../_shared/ai-analyst.js";
import { AiError, answerWithTools, chatCompletion, openAiConfig } from "../_shared/openai.js";
import { loadAnalystDataset } from "../_shared/ai-data.js";

const reportPath = /^\/reports\/([0-9a-f-]{36})$/;
const listColumns = "id,title,store_id,store_name,period_from,period_to,model,created_at";

Deno.serve(async req => {
  if (req.method === "OPTIONS") return json(req, {});
  const path = new URL(req.url).pathname.replace(/^.*\/ai-analyst/, "") || "/";
  const admin = service();
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
    return json(req, { error:"ページが見つかりません" }, 404);
  } catch (error) {
    if (error instanceof AiError) return json(req, { error:error.message }, (error as AiError & { status: number }).status);
    // SQLエラー・APIキー・入力をログや応答に出さない
    console.warn("[ai-analyst] failed");
    return json(req, { error:"処理を完了できませんでした。時間をおいて再度お試しください" }, 500);
  }
});

function publicReport(r: any) {
  return { id:r.id, title:r.title, storeId:r.store_id ?? "all", storeName:r.store_name, from:r.period_from, to:r.period_to, model:r.model, createdAt:r.created_at };
}
