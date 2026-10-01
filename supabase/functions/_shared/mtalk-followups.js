// ログイン情報を更新したあとの取り直し（Node/Deno 共通）。
//
//   アプリでログイン情報を保存 → review-api が planRefetch で取り直しの依頼（agent_requests）を登録する。
//     retry（M-talk のボタンのリンクに入っている失敗した依頼）が本人の同じ店舗×サイトの「最新を調べる」の依頼なら、
//     origin = 'mtalk_live'（夜間・優先でも取得される）にし、mtalk_followups に「結果をそのトークへ送る」を記録する。
//   取得が終わる → agent-api が processFollowups で「再ログイン後の取得結果」を M-talk（/chat-notice）へ1回だけ送る。
//     取得できた: 元の質問に取り直したデータで答える。できなかった: 理由と、ログインの問題ならもう一度「ログイン情報を更新」のボタン。
import { LIVE_SOURCES, SITE_LABELS, RELOGIN_GUIDE, HUMAN_CHECK_GUIDE } from "./mtalk-live.js";
import { publicFailureText } from "./failure-text.js";
import { failureKindOf } from "./agent-requests.js";
import { loginLinks } from "./login-help.js";

export const FOLLOWUP_LIMITS = { maxAttempts: 3, sendingStaleMinutes: 5, giveUpHours: 26, maxRows: 20 };
// M-talk（line_report mtalk-external-post）へ送るお知らせ（署名つき、AI分析 Bot として1対1へ。notice_id で1回だけ）
export const NOTICE_PATH = "/chat-notice";
export const FOLLOWUP_TITLE = "再ログイン後の取得結果";
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const clip = (v, max) => String(v ?? "").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);
const ms = (v) => (v ? Date.parse(v) : NaN);
const jst = (v) => {
  const d = new Date(ms(v) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const siteName = (source) => SITE_LABELS[source] ?? source;

/**
 * ログイン情報の保存後の取り直しの依頼の中身。取得手順の無いサイトは null（依頼しない）。
 * retryRow: リンクの retry の依頼（本人のものだけを渡す。無ければ null）
 * → { row: agent_requests に入れる値, lookupId: 結果を送る M-talk の質問（無ければ null） }
 */
export function planRefetch({ source, storeKey }, retryRow) {
  if (!LIVE_SOURCES.includes(source)) return null;
  const key = String(storeKey ?? "");
  const same = retryRow && retryRow.source === source && String(retryRow.store_id ?? "") === key;
  const lookupId = same && retryRow.origin === "mtalk_live" && typeof retryRow.params?.lookupId === "string" ? retryRow.params.lookupId : null;
  const params = { trigger: "relogin", ...(same ? { retryOf: retryRow.id } : {}), ...(lookupId ? { lookupId } : {}) };
  return { row: { source, store_id: key, action: "sync_now", origin: lookupId ? "mtalk_live" : "app", params }, lookupId };
}

/** 取り直しの依頼の結果 → お知らせの本文と、ボタン（ログインの問題のときだけ）。answer は取得できたときの元の質問への回答（無ければ null）。 */
export function followupMessage({ request, storeName, question }, answerText = null) {
  const where = `${siteName(request.source)}（${clip(storeName, 100) || "店舗"}）`;
  const lines = [`【${FOLLOWUP_TITLE}】`];
  let links = [];
  if (request.status === "done") {
    lines.push(`ログイン情報の更新後、${where}の最新のデータを取得しました${request.finished_at ? `（${jst(request.finished_at)} 取得）` : ""}。`);
    if (question) lines.push(`ご質問：「${clip(question, 60)}${clip(question, 500).length > 60 ? "…" : ""}」`);
    return { text: answerText ? `${lines.join("\n")}\n\n${answerText}` : lines.join("\n"), links };
  }
  const kind = failureKindOf(request);
  // 理由の文（request.error）は出さない。種類から決まった文だけ
  lines.push("ログイン情報の更新後も、取得できませんでした。", `・${publicFailureText({ site: siteName(request.source), storeName, kind })}`);
  links = loginLinks([{ source: request.source, storeId: request.store_id, storeName, requestId: request.id, kind }]);
  if (links.length) lines.push(RELOGIN_GUIDE);
  else if (kind === "needs_human_check") lines.push(HUMAN_CHECK_GUIDE);
  return { text: lines.join("\n"), links };
}

/**
 * 取り直しが終わった依頼のお知らせを送る（agent-api が取得の完了・失敗・確認のたびに呼ぶ）。
 * store: { openFollowups(owner) → [{ request_id, status, attempts, created_at, sending_at, lookup, request, storeName }], updateFollowup(id, from, patch) }
 * deps: { answer({ question, history, system, lookup }) → { text }, notice({ noticeId, lookup, parts, links }), split(text), now() }
 */
export async function processFollowups(store, deps, ownerUserId) {
  const now = deps.now?.() ?? Date.now();
  const iso = () => new Date(deps.now?.() ?? Date.now()).toISOString();
  const out = { checked: 0, sent: 0, waiting: 0, failed: 0, retry: 0 };
  for (const f of await store.openFollowups(ownerUserId)) {
    out.checked++;
    const r = f.request;
    if (f.status === "sending" && ms(f.sending_at) + FOLLOWUP_LIMITS.sendingStaleMinutes * 60_000 > now) continue;
    if (!r || !f.lookup) { await store.updateFollowup(f.request_id, [f.status], { status: "failed", error: "依頼または質問が見つかりません" }); out.failed++; continue; }
    if (r.status !== "done" && r.status !== "failed") {
      if (ms(f.created_at) + FOLLOWUP_LIMITS.giveUpHours * 3600_000 <= now) { await store.updateFollowup(f.request_id, [f.status], { status: "failed", error: "取得が終わりませんでした" }); out.failed++; }
      else out.waiting++;
      continue;
    }
    if ((f.attempts ?? 0) >= FOLLOWUP_LIMITS.maxAttempts) { await store.updateFollowup(f.request_id, [f.status], { status: "failed", error: "M-talk へ送れませんでした（3回）" }); out.failed++; continue; }
    const claimed = await store.updateFollowup(f.request_id, [f.status], { status: "sending", sending_at: iso(), attempts: (f.attempts ?? 0) + 1 });
    if (!claimed) continue;
    let answerText = null;
    if (r.status === "done") {
      try {
        const system = [`ログイン情報の更新後に、${siteName(r.source)}（${clip(f.storeName, 100) || "店舗"}）のデータを取り直しました（取り直したデータはすでに関数の結果に入っています）。`,
          "取得できたかどうかの説明はシステムが回答の前に書き足すので、回答では繰り返さないでください。"].join("\n");
        answerText = (await deps.answer({ question: f.lookup.question, history: f.lookup.history ?? [], system, lookup: f.lookup }))?.text ?? null;
      } catch { answerText = "（回答を作れませんでした。もう一度質問すると、取り直したデータで答えます）"; }
    }
    const { text, links } = followupMessage({ request: r, storeName: f.storeName, question: f.lookup.question }, answerText);
    try {
      await deps.notice({ noticeId: f.request_id, lookup: f.lookup, parts: deps.split(text), links });
      await store.updateFollowup(f.request_id, ["sending"], { status: "sent", sent_at: iso(), error: null });
      out.sent++;
    } catch (error) {
      const last = (f.attempts ?? 0) + 1 >= FOLLOWUP_LIMITS.maxAttempts || error?.status === 404;
      await store.updateFollowup(f.request_id, ["sending"], last ? { status: "failed", error: clip(error?.message ?? "M-talk へ送れませんでした", 300) } : { status: "pending" });
      if (last) out.failed++; else out.retry++;
    }
  }
  return out;
}

// ---------- Supabase（service_role）での読み書き ----------
const check = ({ data, error }) => { if (error) throw Object.assign(new Error(error.message ?? "db error"), { code: error.code }); return data; };

export function supabaseFollowupStore(admin) {
  return {
    openFollowups: async (ownerUserId) => {
      const rows = check(await admin.from("mtalk_followups").select("request_id,lookup_id,status,attempts,created_at,sending_at")
        .eq("owner_user_id", ownerUserId).in("status", ["pending", "sending"]).order("created_at").limit(FOLLOWUP_LIMITS.maxRows)) ?? [];
      if (!rows.length) return [];
      const requests = check(await admin.from("agent_requests").select("id,source,store_id,status,error,failure_kind,finished_at,origin")
        .eq("user_id", ownerUserId).in("id", rows.map((r) => r.request_id))) ?? [];
      const lookups = check(await admin.from("mtalk_live_lookups").select("id,owner_user_id,mtalk_user_id,mtalk_group_id,question,history")
        .eq("owner_user_id", ownerUserId).in("id", [...new Set(rows.map((r) => r.lookup_id))])) ?? [];
      const sites = check(await admin.from("store_sites").select("source,site_store_key,stores(name)").eq("user_id", ownerUserId)) ?? [];
      return rows.map((f) => {
        const request = requests.find((x) => x.id === f.request_id) ?? null;
        const site = request ? sites.find((s) => s.source === request.source && s.site_store_key === (request.store_id ?? "")) : null;
        return { ...f, request, lookup: lookups.find((l) => l.id === f.lookup_id) ?? null, storeName: site?.stores?.name ?? "" };
      });
    },
    updateFollowup: async (requestId, from, patch) => (check(await admin.from("mtalk_followups").update(patch).eq("request_id", requestId).in("status", from).select("request_id")) ?? [])[0] ?? null,
  };
}

/**
 * ログイン情報の保存後に取り直しを依頼する（review-api。service_role、本人の user_id に限る）。
 * → { status: "queued" | "already_open" | "not_supported" | "failed", requestId?, mtalk: boolean, message }
 */
export async function queueRefetchAfterSave(admin, userId, { source, storeKey, retry }) {
  let retryRow = null;
  if (retry) {
    const rows = check(await admin.from("agent_requests").select("id,source,store_id,origin,params,status").eq("user_id", userId).eq("id", retry).limit(1)) ?? [];
    retryRow = rows[0] ?? null;
  }
  const plan = planRefetch({ source, storeKey }, retryRow);
  if (!plan) return { status: "not_supported", mtalk: false, message: "このサイトは自動での取り直しに対応していません。必要なら「取得依頼」から依頼してください" };
  let requestId = null, status = "queued";
  const { data, error } = await admin.from("agent_requests").insert({ user_id: userId, ...plan.row }).select("id").single();
  if (!error) requestId = data.id;
  else if (error.code === "23505") {
    const open = check(await admin.from("agent_requests").select("id,status,origin").eq("user_id", userId).eq("source", plan.row.source)
      .eq("store_id", plan.row.store_id).eq("action", "sync_now").in("status", ["queued", "claimed"]).limit(1)) ?? [];
    if (!open[0]) return { status: "failed", mtalk: false, message: "取り直しを依頼できませんでした。「取得依頼」から依頼してください" };
    requestId = open[0].id; status = "already_open";
    if (plan.lookupId && open[0].status === "queued" && open[0].origin !== "mtalk_live") {
      check(await admin.from("agent_requests").update({ origin: "mtalk_live" }).eq("id", requestId).eq("status", "queued"));
    }
  } else {
    return { status: "failed", mtalk: false, message: error.code === "P0429" ? String(error.message ?? "取得依頼が多すぎます") : "取り直しを依頼できませんでした。「取得依頼」から依頼してください" };
  }
  let mtalk = false;
  if (plan.lookupId) {
    const { error: fe } = await admin.from("mtalk_followups").upsert({ request_id: requestId, owner_user_id: userId, lookup_id: plan.lookupId, kind: "relogin" },
      { onConflict: "request_id", ignoreDuplicates: true });
    mtalk = !fe;
  }
  return {
    status, requestId, mtalk,
    message: `${status === "already_open" ? "取得の依頼はすでに処理待ちです" : "最新の取得をGrok Botへ依頼しました"}（約5分ごとに確認されます）${mtalk ? "。結果は M-talk のトークにもお知らせします" : ""}`,
  };
}
