// 取得依頼（アプリの「今すぐ取得」・ログイン情報保存後の取り直し）を登録した直後に、Grok Bot のルーチンの Webhook を呼んで
// すぐ取得を始めてもらう（Node/Deno 共通）。自動取得の設定（origin = 'schedule'、agent-api /schedules/enqueue-due）は呼ばない
// （毎朝のルーチンが処理する）。
//
//   ・URL / キーは Edge Function の secrets GROKBOT_REFETCH_WEBHOOK_URL / GROKBOT_REFETCH_WEBHOOK_KEY。どちらか未設定なら何もしない。
//   ・本文は { requestId, source, storeId, requestedAt } だけ（個人情報・ログイン情報は入れない）。
//   ・キーは Authorization: Bearer と X-Webhook-Key の両方で送る（Grok Bot 側の期待するヘッダーは要確認（推測））。
//   ・短いタイムアウト。失敗しても依頼の登録は成功のまま（ログにはキー・URLを出さない）。
//   ・間引き: 直前2分以内に、この依頼以外のアプリ発の依頼（schedule 以外）が登録されていれば呼ばない
//     （その時の呼び出しで起きたルーチンがまとめて取得する）。
export const REFETCH_WEBHOOK_TIMEOUT_MS = 5_000;
export const REFETCH_WEBHOOK_DEBOUNCE_MS = 2 * 60_000;

export function webhookConfig(getEnv) {
  const url = String(getEnv("GROKBOT_REFETCH_WEBHOOK_URL") ?? "").trim();
  const key = String(getEnv("GROKBOT_REFETCH_WEBHOOK_KEY") ?? "").trim();
  if (!url || !key || !/^https:\/\//i.test(url)) return null;
  return { url, key };
}

export function webhookBody(row) {
  return { requestId: String(row.id), source: String(row.source ?? ""), storeId: String(row.store_id ?? ""), requestedAt: row.requested_at ?? new Date().toISOString() };
}

/**
 * row: 登録した agent_requests（id, source, store_id, requested_at, origin）
 * deps: { getEnv, fetch, recentOtherRequests(sinceIso, excludeId) → 件数, log, now }
 * → "skipped_config" | "skipped_schedule" | "debounced" | "sent" | "failed"
 */
export async function notifyRefetchWebhook(row, deps) {
  const log = deps.log ?? (() => {});
  try {
    if (!row?.id || row.origin === "schedule") return "skipped_schedule";
    const config = webhookConfig(deps.getEnv);
    if (!config) return "skipped_config";
    const now = deps.now ? deps.now() : Date.now();
    if (deps.recentOtherRequests) {
      const since = new Date(now - REFETCH_WEBHOOK_DEBOUNCE_MS).toISOString();
      const count = await deps.recentOtherRequests(since, row.id);
      if (count > 0) return "debounced";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REFETCH_WEBHOOK_TIMEOUT_MS);
    try {
      const res = await (deps.fetch ?? fetch)(config.url, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}`, "X-Webhook-Key": config.key },
        body: JSON.stringify(webhookBody(row)),
      });
      try { await res.body?.cancel?.(); } catch { /* 本文は使わない */ }
      if (!res.ok) { log(`refetch webhook: HTTP ${res.status}`); return "failed"; }
      return "sent";
    } finally { clearTimeout(timer); }
  } catch (error) {
    log(`refetch webhook: ${error?.name === "AbortError" ? "timeout" : "error"}`);
    return "failed";
  }
}

/** Supabase の admin クライアントで間引きの件数を数える関数 */
export function recentOtherRequestsQuery(admin) {
  return async (sinceIso, excludeId) => {
    const { count, error } = await admin.from("agent_requests").select("id", { count: "exact", head: true })
      .neq("origin", "schedule").neq("id", excludeId).gte("requested_at", sinceIso);
    if (error) return 0; // 数えられなければ呼ぶ側に倒す
    return count ?? 0;
  };
}

/** Edge Function から: レスポンスを待たせずに呼ぶ（EdgeRuntime.waitUntil があれば使う） */
export function fireRefetchWebhook(row, deps) {
  const task = notifyRefetchWebhook(row, deps).catch(() => "failed");
  const rt = globalThis.EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") { try { rt.waitUntil(task); } catch { /* 無視 */ } }
  return task;
}
