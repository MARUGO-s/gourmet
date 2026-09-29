// OpenAI Chat Completions の呼び出し（Node/Edge 共通。fetch は差し替え可能＝テスト用）。
// APIキーはサーバーの環境変数（OPENAI_API_KEY）だけに置き、ブラウザ・ログ・応答へ出さない。
import { AI_LIMITS, AI_TOOLS, runTool } from "./ai-analyst.js";

export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export class AiError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 502) { super(message); this.status = status; }
}
// 推論モデル（gpt-5 系・o 系）は temperature を受け付けず、reasoning_effort を受け付ける
export const isReasoningModel = (model) => /^(gpt-5|o\d)/.test(String(model));

export function openAiConfig(env) {
  const apiKey = env("OPENAI_API_KEY")?.trim() ?? "";
  const model = env("OPENAI_MODEL")?.trim() || "gpt-5-mini";
  const effort = env("OPENAI_REASONING_EFFORT")?.trim() || "low";
  return { apiKey, model, reasoningEffort: ["minimal", "low", "medium", "high", "none"].includes(effort) ? effort : "low" };
}

/** @param {{ apiKey: string, model: string, reasoningEffort?: string }} config @param {any} payload @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options] */
export async function chatCompletion(config, payload, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (!config.apiKey) throw new AiError("AI分析は未設定です（管理者がサーバーに OPENAI_API_KEY を設定すると利用できます）", 503);
  const body = { model: config.model, ...payload };
  if (isReasoningModel(config.model) && config.reasoningEffort && config.reasoningEffort !== "none") body.reasoning_effort = config.reasoningEffort;
  let res;
  try {
    res = await fetchImpl(OPENAI_URL, {
      method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new AiError(timeout ? "AIの応答が時間内に返りませんでした。期間を短くするか、時間をおいて再度お試しください" : "AIに接続できませんでした。時間をおいて再度お試しください", 504);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // エラー本文（キーの一部を含むことがある）はそのまま返さない
    const code = data?.error?.code ?? data?.error?.type ?? "";
    if (res.status === 401) throw new AiError("AIのAPIキーが無効です（管理者に OPENAI_API_KEY の確認を依頼してください）", 503);
    if (res.status === 404 || code === "model_not_found") throw new AiError(`AIのモデル「${config.model}」を利用できません（OPENAI_MODEL を確認してください）`, 503);
    if (res.status === 429) throw new AiError(code === "insufficient_quota" ? "AIの利用枠を超えています（OpenAIの請求設定を確認してください）" : "AIへのリクエストが混み合っています。少し待ってから再度お試しください", 429);
    if (res.status === 400) throw new AiError("AIへのリクエストが受け付けられませんでした（質問・期間を短くしてお試しください）", 502);
    throw new AiError(`AIの処理に失敗しました（HTTP ${res.status}）`, 502);
  }
  const choice = data?.choices?.[0];
  if (!choice?.message) throw new AiError("AIの応答の形式が不正です", 502);
  return { message: choice.message, finishReason: choice.finish_reason ?? null, usage: data.usage ?? null, model: data.model ?? config.model };
}

const addUsage = (a, u) => ({ prompt_tokens: (a.prompt_tokens ?? 0) + (u?.prompt_tokens ?? 0), completion_tokens: (a.completion_tokens ?? 0) + (u?.completion_tokens ?? 0) });

// 質問への回答。モデルは AI_TOOLS の関数だけを呼べる（引数は runTool で検証し、本人のデータの集計だけを返す）。
/** @param {any} config @param {{ ds: any, messages: any[], ctx: any, maxTokens?: number }} input @param {{ fetchImpl?: typeof fetch }} [options] */
export async function answerWithTools(config, { ds, messages, ctx, maxTokens = 6000 }, options = {}) {
  const convo = [...messages];
  const calls = [];
  let usage = {}, model = config.model;
  for (let round = 0; round <= AI_LIMITS.toolRounds; round++) {
    const last = round === AI_LIMITS.toolRounds;
    const r = await chatCompletion(config, { messages: convo, tools: AI_TOOLS, tool_choice: last ? "none" : "auto", max_completion_tokens: maxTokens }, options);
    usage = addUsage(usage, r.usage); model = r.model;
    const toolCalls = (r.message.tool_calls ?? []).filter((t) => t?.type === "function");
    if (!toolCalls.length || last) {
      const answer = typeof r.message.content === "string" ? r.message.content.trim() : "";
      if (!answer) throw new AiError(r.finishReason === "length" ? "AIの回答が長すぎて途中で終了しました。質問を絞ってお試しください" : "AIから回答が得られませんでした。質問を変えてお試しください", 502);
      return { answer, calls, usage, model };
    }
    convo.push({ role: "assistant", content: r.message.content ?? null, tool_calls: toolCalls });
    for (const t of toolCalls.slice(0, 8)) {
      const result = runTool(ds, t.function?.name, t.function?.arguments ?? "{}", ctx);
      let args = {};
      try { args = JSON.parse(t.function?.arguments || "{}"); } catch { args = {}; }
      calls.push({ name: String(t.function?.name ?? ""), args });
      convo.push({ role: "tool", tool_call_id: t.id, content: result });
    }
    // 8件を超える同時呼び出しには空の結果を返す（tool_call_id の対応を崩さない）
    for (const t of toolCalls.slice(8)) convo.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify({ error: "一度に呼べる関数は8件までです" }) });
  }
  throw new AiError("AIから回答が得られませんでした", 502);
}
