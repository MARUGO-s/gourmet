// OpenAI Chat Completions の呼び出し（Node/Edge 共通。fetch は差し替え可能＝テスト用）。
// APIキーはサーバーの環境変数（OPENAI_API_KEY）だけに置き、ブラウザ・ログ・応答へ出さない。
import { AI_LIMITS, AI_TOOLS, DEFAULT_MODEL, runTool } from "./ai-analyst.js";
import { SAFE_NO_DATA_ANSWER, buildEvidence, ensureScopeMention, hasClaims, labelSpeculation, sanitizeAnswer, stripCitations, verificationFeedback, verifyAnswer } from "./answer-verify.js";

export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export class AiError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 502) { super(message); this.status = status; }
}
// 推論モデル（gpt-5 系・gpt-5.x・gpt-6 系・o 系）は temperature を受け付けず、reasoning_effort を受け付ける
export const isReasoningModel = (model) => /^(gpt-5|gpt-6|o\d)/.test(String(model));
// gpt-6 系は、Chat Completions で関数（tools）を使うとき reasoning_effort "none" しか受け付けない
export const isGpt6Model = (model) => /^gpt-6/.test(String(model));
// reasoning_effort "none" を受け付けるモデル（gpt-5.1 以降・gpt-6 系）。gpt-5 / gpt-5-mini / o 系は "none" を送らない
const supportsNoneEffort = (model) => /^(gpt-5\.\d|gpt-6)/.test(String(model));

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"];

export function openAiConfig(env) {
  const apiKey = env("OPENAI_API_KEY")?.trim() ?? "";
  const model = env("OPENAI_MODEL")?.trim() || DEFAULT_MODEL;
  const effort = env("OPENAI_REASONING_EFFORT")?.trim() || "low";
  return { apiKey, model, reasoningEffort: REASONING_EFFORTS.includes(effort) ? effort : "low" };
}

/** 送信する reasoning_effort（送らない場合は undefined）
 * @param {string} model @param {string | undefined} effort @param {{ tools?: boolean }} [opts] */
export function reasoningEffortFor(model, effort, { tools = false } = {}) {
  if (!isReasoningModel(model)) return undefined;
  if (tools && isGpt6Model(model)) return "none";
  const e = effort || "low";
  if (e === "none") return supportsNoneEffort(model) ? "none" : undefined;
  return e;
}

/** Chat Completions のリクエスト本文を組み立てる（キーは含めない）
 * @param {{ model: string, reasoningEffort?: string }} config @param {any} payload */
export function buildChatRequest(config, payload) {
  const body = { model: config.model, ...payload };
  const tools = Array.isArray(payload?.tools) && payload.tools.length > 0;
  const effort = reasoningEffortFor(config.model, config.reasoningEffort, { tools });
  if (effort) body.reasoning_effort = effort;
  else delete body.reasoning_effort;
  return body;
}

/** @param {{ apiKey: string, model: string, reasoningEffort?: string }} config @param {any} payload @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options] */
export async function chatCompletion(config, payload, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (!config.apiKey) throw new AiError("AI分析は未設定です（管理者がサーバーに OPENAI_API_KEY を設定すると利用できます）", 503);
  const body = buildChatRequest(config, payload);
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

// 回答の検証の設定。書き直しは1回だけ。残り時間が少なければ書き直さずに安全な形（確認できた行だけ）にする。
export const ANSWER_GUARD = { defaultDeadlineMs: 90_000, regenerateMinMs: 25_000, minCallMs: 5_000, extraRoundsAfterFeedback: 2 };
export const NEED_TOOL_FEEDBACK = "【自動検証】データに関する回答には、この質問で呼んだ関数の結果が必要です。関数を呼んで確認してから答えてください。データで確認できない場合は「データでは確認できません」と答えてください。";

// 関数の結果に ref（T1, T2 …）を付ける。回答の〔T1〕はこれを指す
function withRef(result, ref) {
  try {
    const v = JSON.parse(result);
    if (v && typeof v === "object" && !Array.isArray(v)) return { text: JSON.stringify({ ref, ...v }), value: v };
  } catch { /* そのまま */ }
  return { text: result, value: result };
}
function scopeOf(v) {
  if (!v || typeof v !== "object") return null;
  const p = v.period;
  const period = typeof p === "string" ? p : p && typeof p === "object" && p.from ? `${p.from} 〜 ${p.to}` : v.from ? `${v.from} 〜 ${v.to}` : null;
  if (!period) return null;
  const sites = Array.isArray(v.sites) ? v.sites.filter((x) => typeof x === "string").join("・") : "";
  return { sites: sites || String(v.store ?? "全サイト"), period };
}

// 質問への回答。モデルは AI_TOOLS の関数だけを呼べる（引数は runTool で検証し、本人のデータの集計だけを返す）。
// 回答は answer-verify.js で、この質問の関数の結果とサーバーの事実（evidenceTexts）だけと照合する:
//   関数を呼ばずに数値・日付を書いた → 関数を必ず呼ぶ指示で1回やり直す（それでも呼ばなければ「わかりません」）
//   合わない値がある → 指摘を付けて1回だけ書き直し → それでも合わなければ合わない行を除き、確認できなかったと明記
/** @param {any} config @param {{ ds: any, messages: any[], ctx: any, maxTokens?: number, evidenceTexts?: string[], question?: string, deadlineMs?: number }} input @param {{ fetchImpl?: typeof fetch, now?: () => number }} [options] */
export async function answerWithTools(config, { ds, messages, ctx, maxTokens = 6000, evidenceTexts = [], question = "", deadlineMs = ANSWER_GUARD.defaultDeadlineMs }, options = {}) {
  const now = options.now ?? Date.now;
  const started = now();
  const remaining = () => deadlineMs - (now() - started);
  const convo = [...messages];
  const calls = [];
  const toolResults = [];
  const scopes = [];
  const usedSites = new Set(); // 関数の結果の sites（表示名）。答えの最後に付けるデータの鮮度に使う
  let usage = {}, model = config.model;
  let round = 0, extraRounds = 0, forcedTool = false, regenerated = false, toolChoice = "auto";
  const finish = (answer, status, issues = 0) => {
    let text = stripCitations(answer).trim();
    if (status !== "no_data") text = ensureScopeMention(labelSpeculation(text), scopes);
    return { answer: text, calls, usage, model, verification: { status, issues }, sites: [...usedSites] };
  };
  const evidence = () => buildEvidence([...evidenceTexts, ...toolResults], { allowedText: question });
  for (;;) {
    if (remaining() < ANSWER_GUARD.minCallMs) throw new AiError("AIの応答が時間内に返りませんでした。質問を短くするか、時間をおいて再度お試しください", 504);
    const last = round >= AI_LIMITS.toolRounds + extraRounds;
    const r = await chatCompletion(config, { messages: convo, tools: AI_TOOLS, tool_choice: last ? "none" : toolChoice, max_completion_tokens: maxTokens },
      { ...options, timeoutMs: Math.max(ANSWER_GUARD.minCallMs, Math.min(120_000, remaining())) });
    toolChoice = "auto";
    usage = addUsage(usage, r.usage); model = r.model;
    const toolCalls = (r.message.tool_calls ?? []).filter((t) => t?.type === "function");
    if (toolCalls.length && !last) {
      convo.push({ role: "assistant", content: r.message.content ?? null, tool_calls: toolCalls });
      for (const t of toolCalls.slice(0, 8)) {
        const ref = `T${toolResults.length + 1}`;
        const { text, value } = withRef(runTool(ds, t.function?.name, t.function?.arguments ?? "{}", ctx), ref);
        toolResults.push(value);
        const sc = scopeOf(value); if (sc) scopes.push(sc);
        for (const name of Array.isArray(value?.sites) ? value.sites : []) if (typeof name === "string") usedSites.add(name);
        let args = {};
        try { args = JSON.parse(t.function?.arguments || "{}"); } catch { args = {}; }
        calls.push({ name: String(t.function?.name ?? ""), args });
        convo.push({ role: "tool", tool_call_id: t.id, content: text });
      }
      // 8件を超える同時呼び出しには空の結果を返す（tool_call_id の対応を崩さない）
      for (const t of toolCalls.slice(8)) convo.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify({ error: "一度に呼べる関数は8件までです" }) });
      round++;
      continue;
    }
    const answer = typeof r.message.content === "string" ? r.message.content.trim() : "";
    if (!answer) throw new AiError(r.finishReason === "length" ? "AIの回答が長すぎて途中で終了しました。質問を絞ってお試しください" : "AIから回答が得られませんでした。質問を変えてお試しください", 502);
    // 関数を呼ばずにデータ（数値・日付）を答えた
    if (!calls.length && hasClaims(stripCitations(answer))) {
      if (!forcedTool && remaining() > ANSWER_GUARD.regenerateMinMs) {
        forcedTool = true;
        convo.push({ role: "assistant", content: answer }, { role: "user", content: NEED_TOOL_FEEDBACK });
        toolChoice = "required"; extraRounds += ANSWER_GUARD.extraRoundsAfterFeedback; round++;
        continue;
      }
      return finish(SAFE_NO_DATA_ANSWER, "no_data");
    }
    const check = verifyAnswer(answer, evidence());
    if (check.ok) return finish(answer, regenerated ? "regenerated" : "verified");
    if (!regenerated && remaining() > ANSWER_GUARD.regenerateMinMs) {
      regenerated = true;
      convo.push({ role: "assistant", content: answer }, { role: "user", content: verificationFeedback(check.issues) });
      extraRounds += ANSWER_GUARD.extraRoundsAfterFeedback; round++;
      continue;
    }
    return finish(sanitizeAnswer(answer, check.issues), "sanitized", check.issues.length);
  }
}
