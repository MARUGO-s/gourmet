// 外部エージェント（Grok Bot）専用API。ブラウザからは使わない（CORS許可なし）。
// 認証: X-Ingest-Token ヘッダー = Supabase secret INGEST_TOKEN（定数時間比較）。
// 対象利用者: Supabase secret INGEST_USER_ID（トークン1つ=利用者1名。リクエストで利用者を指定できない）。
//   POST /agent-api/ingest                 任意のサイトの日別・月別・口コミ・レポートを取り込む（冪等。source="ikyu" は一休形式）
//   POST /agent-api/ikyu/ingest            一休の取り込み（/ingest の一休形式と同じ）
//   POST /agent-api/credentials/versions   登録済み資格情報の一覧（版・更新日時のみ。秘密情報なし）
//   POST /agent-api/credentials/fetch      店舗×サイトの資格情報を復号して返す（毎回 credential_access_log に記録）
//   POST /agent-api/requests/pending       アプリからの取得依頼（依頼中・取得中）の一覧
//   POST /agent-api/requests/claim         依頼を原子的に取得開始（FOR UPDATE SKIP LOCKED）
//   POST /agent-api/requests/complete      取得完了を報告
//   POST /agent-api/requests/fail          取得失敗を報告（failureKind: needs_relogin | needs_human_check | other。省略時は理由の文から判定）
//   （/requests/pending・/requests/claim は origin（app | schedule | mtalk_live）で絞れる。Grok Bot は 9:00〜22:59 以外は mtalk_live だけ）
//   POST /agent-api/schedules/enqueue-due  自動取得の設定（fetch_schedules）のうち予定時刻を過ぎたものを取得依頼にする
//   POST /agent-api/alerts/dispatch        口コミ通知（新着口コミ・総合点の変化）の送信待ちを M-talk へ送る（結果を返す）
// 口コミ通知は取り込み（/ingest）の直後と取得依頼の確認（/requests/pending、Grok Bot が数分ごと）のたびにバックグラウンドでも送る。
// 検出は DB トリガー（migration 017）。送信は店舗の M-talk 店舗Botとして、その Bot が参加しているグループのルームへ
// line_report mtalk-external-post POST /alert（GOURMET_MTALK_TOKEN + HMAC、ai-analyst と同じ秘密情報）。Bot の自動判定は GET /store-bots。
import { service, body } from "../_shared/http.ts";
import { decrypt } from "../_shared/crypto.ts";
import { NOTICE_PATH, processFollowups, supabaseFollowupStore } from "../_shared/mtalk-followups.js";
import { must } from "../_shared/sync-data.js";
import { getSource } from "../_shared/sources.js";
import { unpackIkyuUsername } from "../_shared/ikyu-login.js";
import { normalizeIkyuIngest } from "../_shared/ikyu-data.js";
import { normalizeSourceIngest } from "../_shared/source-ingest.js";
import { publicRequest, validateFinish } from "../_shared/agent-requests.js";
import { enqueueDueSchedules, supabaseScheduleStore, ENQUEUE_LIMIT } from "../_shared/fetch-schedules.js";
import { ALERT_LIMITS, ALERT_PATH, STORE_BOTS_PATH, dispatchReviewAlerts, normalizeStoreBots, supabaseAlertStore } from "../_shared/review-alerts.js";
import { mtalkConfig, mtalkRequest } from "../_shared/mtalk-share.js";
import { REQUEST_ORIGINS } from "../_shared/agent-requests.js";
import { LIVE_REPLY_PATH, processLiveLookups, supabaseLiveStore } from "../_shared/mtalk-live.js";
import { answerMtalkQuestion, resolveMtalkOwner } from "../_shared/mtalk-answer.js";
import { splitReply } from "../_shared/mtalk-chat.js";

// 口コミ通知の送信（同時に2つ走っても claim_review_alert_events が1回だけ確保する）。失敗しても取り込みの応答には影響させない
function runAlerts(admin: any, userId: string) {
  const mtalk = mtalkConfig((k: string) => Deno.env.get(k));
  return dispatchReviewAlerts(supabaseAlertStore(admin, userId), {
    configured: mtalk.configured,
    send: (_bot: string, payload: unknown) => mtalkRequest(mtalk, "POST", ALERT_PATH, payload, { timeoutMs: ALERT_LIMITS.timeoutMs }),
    listBots: async () => normalizeStoreBots(await mtalkRequest(mtalk, "GET", STORE_BOTS_PATH, null, { timeoutMs: ALERT_LIMITS.timeoutMs })),
  });
}
function alertsInBackground(admin: any, userId: string) {
  const work = runAlerts(admin, userId).catch(() => console.warn("[agent-api] review alerts dispatch failed"));
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work);
}

// M-talk の「最新を調べる」: 取得依頼がすべて終わった質問に、取り直したデータで答えて M-talk（/chat-reply）へ送る。
// 取得の完了・失敗の報告と、Grok Bot の数分ごとの確認（/requests/pending）のたびにバックグラウンドで確かめる（同じ質問は1回だけ答える）
function runLive(admin: any, userId: string) {
  const mtalk = mtalkConfig((k: string) => Deno.env.get(k));
  if (!mtalk.configured) return Promise.resolve({ notConfigured: true });
  const env = (k: string) => Deno.env.get(k);
  // 質問したときと同じ前提（そのトークへ最後に届いたレポート）で答える。持ち主は依頼を処理した INGEST_USER_ID に限る
  const answer = async ({ question, history, system, lookup }: { question: string; history: any[]; system?: string; lookup: any }) => {
    const owner = await resolveMtalkOwner(admin, lookup.mtalk_user_id, Number(lookup.mtalk_group_id), userId);
    return answerMtalkQuestion(admin, env, { mtalkUserId: lookup.mtalk_user_id, owner: owner?.userId === userId ? owner : { userId, reportId: null },
      question, history, system: system ?? null });
  };
  const split = (text: string) => splitReply(text);
  return processLiveLookups(supabaseLiveStore(admin), {
    answer,
    // links = 「ログイン情報を更新」のボタン（アプリの登録画面。ボタンの文と URL の確認は line_report 側）
    post: ({ lookup, parts, links }: { lookup: any; parts: string[]; links?: any[] }) => mtalkRequest(mtalk, "POST", LIVE_REPLY_PATH,
      { lookup_id: lookup.id, mtalk_user_id: lookup.mtalk_user_id, mtalk_group_id: Number(lookup.mtalk_group_id), parts, ...(links?.length ? { links } : {}) }, { timeoutMs: 15_000 }),
    split,
    now: () => Date.now(),
  }, userId).then(async (live) => {
    // ログイン情報を更新したあとの取り直しの結果（「再ログイン後の取得結果」）
    const followups = await processFollowups(supabaseFollowupStore(admin), {
      answer, split, now: () => Date.now(),
      notice: ({ noticeId, lookup, parts, links }: { noticeId: string; lookup: any; parts: string[]; links: any[] }) => mtalkRequest(mtalk, "POST", NOTICE_PATH,
        { notice_id: noticeId, mtalk_user_id: lookup.mtalk_user_id, mtalk_group_id: Number(lookup.mtalk_group_id), parts, ...(links.length ? { links } : {}) }, { timeoutMs: 15_000 }),
    }, userId);
    return { live, followups };
  });
}

function liveInBackground(admin: any, userId: string) {
  const work = runLive(admin, userId).catch(() => console.warn("[agent-api] mtalk live answers failed"));
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work);
}

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

async function authorized(req: Request) {
  const expected = Deno.env.get("INGEST_TOKEN");
  const actual = req.headers.get("x-ingest-token");
  if (!expected || expected.length < 32 || !actual) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(expected), digest(actual)]);
  return a.reduce((diff, n, i) => diff | (n ^ b[i]), 0) === 0;
}

const validKey = (source: unknown, storeKey: unknown) => typeof source === "string" && !!getSource(source)
  && typeof storeKey === "string" && (source === "ikyu" ? /^\d{6}$/.test(storeKey) : /^[0-9A-Za-z_-]{0,40}$/.test(storeKey));

Deno.serve(async (req) => {
  if (req.method !== "POST" || !await authorized(req)) return reply({ error: "Unauthorized" }, 401);
  const userId = Deno.env.get("INGEST_USER_ID") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(userId)) return reply({ error: "Ingest user is not configured" }, 500);
  const path = new URL(req.url).pathname.replace(/^.*\/agent-api/, "");
  const admin = service();
  let input: any;
  try { input = await body(req, 8_000_000); } catch { return reply({ error: "JSONを読み取れません（8MBまで）" }, 400); }
  const invalid = (error: unknown) => reply({ error: String((error as Error)?.message ?? "リクエストが不正です").slice(0, 300) }, 422);
  try {
    if (path === "/ingest" || path === "/ikyu/ingest") {
      if (path === "/ikyu/ingest" || input?.source === "ikyu") {
        let normalized;
        try { normalized = normalizeIkyuIngest(input); } catch (error) { return invalid(error); }
        const saved = await must(admin.rpc("ingest_ikyu", { p_user: userId, p_run: normalized.run, p_stores: normalized.stores }));
        alertsInBackground(admin, userId);
        return reply({ ok: true, source: "ikyu", status: normalized.run.status, skippedDays: normalized.skippedDays, ...saved });
      }
      let normalized;
      try { normalized = normalizeSourceIngest(input); } catch (error) { return invalid(error); }
      const saved = await must(admin.rpc("ingest_source", { p_user: userId, p_source: normalized.source, p_run: normalized.run, p_stores: normalized.stores }));
      // 食べログの公開店舗ページ（口コミ通知のリンク用。取り込みの検証済み）
      for (const st of normalized.stores.filter((x: any) => x.public_url)) {
        await admin.from("source_stores").update({ public_url: st.public_url }).eq("user_id", userId).eq("source", normalized.source).eq("store_key", st.store_key)
          .then(({ error }: any) => { if (error) console.warn("[agent-api] public_url update failed"); });
      }
      alertsInBackground(admin, userId);
      return reply({ ok: true, source: normalized.source, status: normalized.run.status, skippedDays: normalized.skippedDays, ...saved });
    }
    if (path === "/requests/pending") {
      const source = input?.source ?? null, origin = input?.origin ?? null;
      if (source != null && !getSource(source)) return reply({ error: "source が不正です" }, 400);
      if (origin != null && !REQUEST_ORIGINS.includes(origin)) return reply({ error: "origin が不正です" }, 400);
      let query = admin.from("agent_requests").select("*").eq("user_id", userId).in("status", ["queued", "claimed"]).order("requested_at").limit(100);
      if (source) query = query.eq("source", source);
      if (origin) query = query.eq("origin", origin);
      const rows = await must(query);
      alertsInBackground(admin, userId); // 送れなかった通知のやり直し（数分ごとの確認に相乗り）
      liveInBackground(admin, userId); // M-talk の「最新を調べる」で、取得が終わった質問の回答
      return reply({ requests: rows.map((r: any) => publicRequest(r)) });
    }
    if (path === "/requests/claim") {
      const source = input?.source ?? null, limit = input?.limit ?? 1, origin = input?.origin ?? null;
      const agent = typeof input?.agent === "string" ? input.agent.slice(0, 100) : "";
      if ((source != null && !getSource(source)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) return reply({ error: "source / limit（1〜20）が不正です" }, 400);
      if (origin != null && !REQUEST_ORIGINS.includes(origin)) return reply({ error: "origin が不正です" }, 400);
      // origin を指定したときだけ渡す（mtalk_live は指定が無くても他の依頼より先に取得される）
      const rows = await must(admin.rpc("claim_agent_requests", { p_user: userId, p_agent: agent, p_limit: limit, p_source: source, ...(origin ? { p_origin: origin } : {}) }));
      // claimId は完了・失敗の報告に必要（このエージェントだけが知る）
      return reply({ requests: (rows ?? []).map((r: any) => ({ ...publicRequest(r), claimId: r.claim_id })) });
    }
    if (path === "/requests/complete" || path === "/requests/fail") {
      const outcome = path === "/requests/complete" ? "done" : "failed";
      let finish;
      try { finish = validateFinish(input, outcome); } catch (error) { return invalid(error); }
      const { data, error } = await admin.rpc("finish_agent_request", { p_user: userId, p_id: finish.id, p_claim: finish.claimId, p_status: outcome, p_result: finish.result, p_error: finish.error,
        ...(outcome === "failed" ? { p_failure_kind: finish.failureKind } : {}) });
      if (error) return error.message.includes("Invalid claim") ? reply({ error: "取得中の依頼が見つかりません（claimId不一致・期限切れ・他の状態で終了済み）" }, 409) : reply({ error: "処理を完了できませんでした" }, 500);
      // 「最新を調べる」の質問に、すべての取得が終わっていれば答える（ログイン情報の更新後の取り直しの結果も）
      if (data?.origin === "mtalk_live" || data?.params?.trigger === "relogin") liveInBackground(admin, userId);
      return reply({ request: publicRequest(data) });
    }
    if (path === "/schedules/enqueue-due") {
      const limit = input?.limit ?? ENQUEUE_LIMIT, dryRun = input?.dryRun ?? false;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || typeof dryRun !== "boolean") return reply({ error: "limit（1〜50）/ dryRun が不正です" }, 400);
      const result = await enqueueDueSchedules(supabaseScheduleStore(admin, userId), { now: new Date(), limit, dryRun });
      return reply(result);
    }
    if (path === "/alerts/dispatch") {
      const result = await runAlerts(admin, userId);
      return reply(result);
    }
    if (path === "/credentials/versions") {
      const rows = await must(admin.from("credentials").select("source,store_key,label,credentials_version,updated_at").eq("user_id", userId).order("source").order("store_key"));
      return reply({ credentials: rows.map((r: any) => ({ source: r.source, storeKey: r.store_key, label: r.label, credentialsVersion: r.credentials_version, updatedAt: r.updated_at })) });
    }
    if (path === "/credentials/fetch") {
      const { source, storeKey = "", knownVersion = null } = input ?? {};
      const agent = typeof input?.agent === "string" ? input.agent.slice(0, 100) : "";
      if (!validKey(source, storeKey) || (knownVersion != null && !Number.isSafeInteger(knownVersion))) return reply({ error: "source / storeKey が不正です" }, 400);
      const log = (outcome: string, row?: any) => must(admin.from("credential_access_log").insert({
        user_id: userId, credential_id: row?.id ?? null, source, store_key: storeKey, credentials_version: row?.credentials_version ?? null, agent, outcome,
      }));
      const rows = await must(admin.from("credentials").select("id,source,store_key,username,password_enc,credentials_version,updated_at").eq("user_id", userId).eq("source", source).eq("store_key", storeKey).limit(1));
      const row = rows[0];
      if (!row) { await log("not_found"); return reply({ error: "資格情報が登録されていません" }, 404); }
      if (knownVersion === row.credentials_version) {
        await log("unchanged", row);
        return reply({ unchanged: true, source, storeKey, credentialsVersion: row.credentials_version, updatedAt: row.updated_at });
      }
      let password: string;
      try { password = await decrypt(row.password_enc); }
      catch { await log("decrypt_failed", row); return reply({ error: "資格情報を復号できません。アプリで登録し直してください" }, 409); }
      const ikyu = source === "ikyu" ? unpackIkyuUsername(row.username) : null;
      if (source === "ikyu" && !ikyu) { await log("decrypt_failed", row); return reply({ error: "一休の資格情報の形式が不正です。アプリで登録し直してください" }, 409); }
      // 記録できない場合は払い出さない
      await log("issued", row);
      return reply({
        source, storeKey, credentialsVersion: row.credentials_version, updatedAt: row.updated_at,
        fields: ikyu ? { storeId: ikyu.storeId, operatorId: ikyu.operatorId, password } : { loginId: row.username, password },
      });
    }
    return reply({ error: "Not found" }, 404);
  } catch {
    // SQL・秘密情報を返さない
    return reply({ error: "処理を完了できませんでした。既存のデータは保持されています" }, 500);
  }
});
