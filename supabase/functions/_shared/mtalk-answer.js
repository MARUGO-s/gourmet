// M-talk「AI分析」Bot の質問に答える本体（ai-analyst の /mtalk-chat。Deno 用）。データは毎日の取り込み（キャッシュ）で、すぐ答える。
// 答えには使ったサイトごとの鮮度（「データ：一休 10/1 18:30取得（9/1〜9/30）」、古い・無いときは※の行）を照合のあとに付ける。
// /ask と同じモデル・同じ関数・同じ照合（answerWithTools の検証と書き直し）。データはその持ち主の user_id で絞った SELECT だけ。
import { contextMessage, dataCoverage, resolvePeriod, systemPrompt } from "./ai-analyst.js";
import { answerWithTools, openAiConfig } from "./openai.js";
import { loadAnalystDataset } from "./ai-data.js";
import { japanDate } from "./sync-data.js";
import { answerFreshness, freshnessSystemMessage, withCoverage } from "./data-freshness.js";
import { MTALK_CHAT_LIMITS, MtalkChatError, mtalkChatPrompt, reportContextMessage, reportFactLines, resolveDataOwner, scopedReadClient, toMtalkPlainText } from "./mtalk-chat.js";

// line_report 側は100秒で打ち切る（/mtalk-chat）。書き直しを含めてこの時間内に返す
export const MTALK_DEADLINE_MS = 80_000;

/**
 * データの持ち主: このトークへ最後にレポートを送った gourmet 利用者 → 無ければ既定（INGEST_USER_ID）。
 * @param {any} admin @param {string} mtalkUserId @param {number} groupId @param {string} fallbackUserId
 */
export async function resolveMtalkOwner(admin, mtalkUserId, groupId, fallbackUserId) {
  const { data: shares, error } = await admin.from("ai_report_shares").select("user_id,report_id,sent_at")
    .eq("recipient_user_id", mtalkUserId).eq("mtalk_group_id", groupId).eq("status", "sent")
    .order("sent_at", { ascending: false }).limit(1);
  if (error) throw error;
  return resolveDataOwner(shares?.[0] ?? null, fallbackUserId);
}

/** 1時間あたりの回数（ai_usage kind='mtalk'）を超えていれば true。 @param {any} admin @param {string} mtalkUserId */
export async function mtalkOverLimit(admin, mtalkUserId) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await admin.from("ai_usage").select("id", { count: "exact", head: true })
    .eq("kind", "mtalk").eq("mtalk_user_id", mtalkUserId).gte("created_at", since);
  if (error) throw error;
  return (count ?? 0) >= MTALK_CHAT_LIMITS.perHour;
}

/**
 * 質問に答える（M-talk 向けのプレーンテキスト）。system は前提として足す文（任意）。
 * 返り値の links = 取り込みがログイン情報の問題で止まっているサイトの「ログイン情報を更新」ボタン（line_report が答えのあとに送る）。
 * @param {any} admin
 * @param {(k: string) => string | undefined} env
 * @param {{ mtalkUserId: string, owner: { userId: string, reportId: string | null }, question: string, history: any[], system?: string | null, deadlineMs?: number }} input
 */
export async function answerMtalkQuestion(admin, env, input) {
  const config = openAiConfig(env);
  if (!config.apiKey) throw new MtalkChatError("AI分析は現在準備中です（管理者の設定待ち）。しばらくしてからお試しください", 503);
  const { owner } = input;
  /** @type {any} */
  let report = null;
  if (owner.reportId) {
    const { data, error } = await admin.from("ai_reports").select("id,title,store_id,store_name,period_from,period_to,markdown")
      .eq("id", owner.reportId).eq("user_id", owner.userId).limit(1);
    if (error) throw error;
    report = data?.[0] ?? null;
  }
  const today = japanDate();
  const ds = await loadAnalystDataset(scopedReadClient(admin, owner.userId), { today });
  const store = report?.store_id && ds.stores.some((/** @type {any} */ s) => s.id === report.store_id) ? report.store_id : "all";
  const period = report ? { from: String(report.period_from).slice(0, 10), to: String(report.period_to).slice(0, 10) } : resolvePeriod(null, null, today);
  const ask = { store, ...period };
  const reportMessage = reportContextMessage(report);
  const todayYear = Number(today.slice(0, 4));
  const coverage = dataCoverage(ds, store);
  const freshMessage = freshnessSystemMessage(withCoverage(ds.freshness ?? [], coverage), { todayYear });
  const messages = [
    { role: "system", content: systemPrompt(today) },
    { role: "system", content: mtalkChatPrompt() },
    { role: "system", content: contextMessage(ds, ask) },
    ...(reportMessage ? [{ role: "system", content: reportMessage }] : []),
    ...(freshMessage ? [{ role: "system", content: freshMessage }] : []),
    ...(input.system ? [{ role: "system", content: input.system }] : []),
    ...(input.history ?? []),
    { role: "user", content: input.question },
  ];
  /** @type {any} */
  const result = await answerWithTools(config, { ds, messages, ctx: ask, maxTokens: 4000,
    evidenceTexts: [contextMessage(ds, ask), reportFactLines(report), freshMessage], question: input.question, deadlineMs: input.deadlineMs ?? MTALK_DEADLINE_MS });
  await admin.from("ai_usage").insert({ user_id: owner.userId, kind: "mtalk", mtalk_user_id: input.mtalkUserId, model: String(result.model).slice(0, 100),
    prompt_tokens: result.usage?.prompt_tokens ?? null, completion_tokens: result.usage?.completion_tokens ?? null })
    .then((/** @type {any} */ { error }) => { if (error) console.warn("[mtalk-answer] usage log failed"); });
  const body = toMtalkPlainText(result.answer);
  if (!body) throw new MtalkChatError("AIから回答が得られませんでした。質問を変えてお試しください", 502);
  // 鮮度は照合のあとにサーバーが付ける（モデルに書かせない。関数を呼んだ答えだけ）
  const fresh = answerFreshness(result, ds, { todayYear, coverage, period });
  const text = fresh.text ? `${body}\n\n${fresh.text}` : body;
  return { text, model: result.model, calls: result.calls.length, verification: result.verification?.status ?? null, report: report ? { id: report.id, title: report.title } : null,
    links: fresh.links, freshness: fresh.text || null };
}
