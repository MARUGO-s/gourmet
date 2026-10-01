// M-talk「AI分析」Bot の1対1: 質問ごとに「1) サイトにログインして最新を調べる / 2) 今あるデータですぐ答える」を選んでもらう（Node/Deno 共通）。
//
// 流れ（1つのトークで進行中は1件だけ。新しい質問が来たら前の質問は replaced）
//   質問            → 選択待ち（awaiting_choice、30分で期限切れ）を保存し、選択肢（カードのボタン＋「1」「2」の案内文）を返す
//   「2」           → 保存した質問・会話履歴で、今あるデータですぐ答える（ai-analyst の Q&A と同じ照合つき）
//   「1」           → 店舗×サイトの取得依頼（agent_requests、origin = 'mtalk_live'）を登録し、「調べています。終わったらお知らせします」を返す（fetching）
//   取得の完了/失敗 → agent-api がすべての依頼の終了を確かめて、取り直したデータで答え、M-talk（/chat-reply）へ送る（answered）。
//                    取り直せなかったサイトは理由（例: 要再ログイン）を書いて、前回までのデータで答える
//   20分たっても終わらない → line_report の見張り（chat_ai_analysis_live_timeouts）が「「2」を送ってください」と案内する
//
// あいさつ・お礼など（isChitChat）と、最新を取り直せる店舗×サイトが無いとき（ログイン情報の未登録など）は選択肢を出さずにすぐ答える。
import { storeNameVariants } from "./review-alerts.js";
import { SUPPORTED_SCHEDULE_SOURCES } from "./fetch-schedules.js";

export const LIVE_LIMITS = {
  choiceMinutes: 30,          // 選択待ちの期限
  fetchMinutes: 20,           // 「1」を選んでから答えるまでの目安の上限（line_report の見張りも20分）
  choice2AfterFetchMinutes: 120, // 取得中・時間切れのあとでも「2」で答えられる時間
  answeringStaleMinutes: 5,   // 回答作成中のまま止まったものをやり直すまで
  maxAttempts: 3,
  maxTargets: 6,
  questionExcerpt: 60,
  cleanupAfterDeadlineMinutes: 10,
};
export const LIVE_SOURCES = SUPPORTED_SCHEDULE_SOURCES; // 取得手順があるサイト（食べログ・一休）
export const SITE_LABELS = { tabelog: "食べログ", ikyu: "一休", hotpepper: "ホットペッパー", google: "Google", toreta: "トレタ", retty: "Retty" };
export const CHOICE_LABELS = {
  1: "サイトにログインして最新を調べる（時間がかかります：5〜10分ほど）",
  2: "今あるデータですぐ答える（少し正確性が落ちることがあります）",
};
// M-talk（line_report mtalk-external-post）へ「最新を調べる」の回答を送るパス（署名つき、AI分析Bot として1対1へ投稿）
export const LIVE_REPLY_PATH = "/chat-reply";
export const LIVE_ACK = "調べています。終わったらお知らせします";
const ACTIVE = ["awaiting_choice", "fetching", "answering"];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const clip = (v, max) => String(v ?? "").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);
const minutes = (n) => n * 60_000;
const ms = (v) => (v ? Date.parse(v) : NaN);

export class LiveError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** 「1」「２」「①」「1：サイトにログインして…」（カードのボタン）「最新を調べる」「今あるデータで答えて」→ 1 / 2。それ以外は null。 */
export function parseChoice(text) {
  const s = String(text ?? "").normalize("NFKC").replace(CONTROL, "").trim();
  if (!s || s.length > 40) return null;
  const m = s.match(/^[(\[【〔<]?\s*([12])\s*([\s\S]*)$/);
  if (m) {
    const rest = m[2];
    // 「1月」「2024年」「1 日の予約」などの質問は選択にしない（数字の直後が終わり・区切り・選ぶ言い方・ボタンの文だけ）
    if (!rest || /^[)\]】〕>.:、,。](?!\d)/.test(rest) || /^(?:番|で|を?(?:選|えら)|に(?:します|する)|です|がいい|サイト|最新|今ある|いまある)/.test(rest)) return Number(m[1]);
    return null;
  }
  if (/^(?:サイトにログインして)?最新(?:の(?:データ)?)?を?(?:調べ|しらべ)/.test(s)) return 1;
  if (/^(?:今|いま)ある(?:データ)?で(?:すぐ)?(?:答え|こたえ)/.test(s)) return 2;
  return null;
}

/** あいさつ・お礼・相づち・使い方など（データの質問ではない）→ 選択肢を出さずにすぐ答える。 */
export function isChitChat(text) {
  const s = String(text ?? "").normalize("NFKC").toLowerCase().replace(CONTROL, "").replace(/[\s!?！？。、.,~〜ー…w笑☺-➿\u{1F000}-\u{1FAFF}]+/gu, "").trim();
  if (!s) return true;
  if (s.length > 20) return false;
  return /^(?:こんにちは|こんばんは|おはよう(?:ございます)?|はじめまして|ありがと(?:う)?(?:ございます|ございました)?|どうも(?:ありがとう)?|サンキュー|thanks|thankyou|thx|了解(?:です|しました)?|りょうかい(?:です)?|わかりました|分かりました|承知(?:しました|です)?|ok(?:です)?|おk|おけ|はい|いいえ|うん|ううん|なるほど|すごい|助かります|たすかります|よろしく(?:お願いします|おねがいします|です)?|お疲れ(?:様|さま)(?:です)?|おつかれ(?:さま)?(?:です)?|さようなら|またね|おやすみ(?:なさい)?|hi|hello|hey|テスト|test|何ができる(?:の)?|なにができる(?:の)?|何ができますか|なにができますか|使い方|つかいかた|ヘルプ|help)$/.test(s);
}

const jst = (v) => {
  const d = new Date(ms(v) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const excerpt = (q) => { const s = clip(q, 500); return s.length > LIVE_LIMITS.questionExcerpt ? `${s.slice(0, LIVE_LIMITS.questionExcerpt)}…` : s; };

/** 選択肢の返事（line_report はカードのボタン、古い line_report は parts の文だけを表示する）。 */
export function choiceReply(question, { replacedFetching = false, expiresAt = null } = {}) {
  const lines = [
    ...(replacedFetching ? ["前の質問の「最新を調べる」は取りやめました。"] : []),
    `ご質問：「${excerpt(question)}」`,
    "どちらで調べますか？ 下のボタンを押すか、番号（1 または 2）を送ってください。",
    `1. ${CHOICE_LABELS[1]}`,
    `2. ${CHOICE_LABELS[2]}`,
    `※${LIVE_LIMITS.choiceMinutes}分以内に選んでください。`,
  ];
  return {
    parts: [lines.join("\n")],
    choice: { question: excerpt(question), options: [{ value: 1, label: CHOICE_LABELS[1] }, { value: 2, label: CHOICE_LABELS[2] }], expires_at: expiresAt },
  };
}

/** 店舗×サイトの一覧を「BISTRO CAVACAVA の食べログ・一休」の形に。 */
export function describeTargets(targets) {
  const byStore = new Map();
  for (const t of targets) {
    const name = clip(t.storeName, 100) || "店舗名未設定";
    if (!byStore.has(name)) byStore.set(name, []);
    const label = SITE_LABELS[t.source] ?? t.source;
    if (!byStore.get(name).includes(label)) byStore.get(name).push(label);
  }
  return [...byStore].map(([name, sites]) => `${name} の${sites.join("・")}`).join("、");
}

/**
 * 取り直す店舗×サイト。available はログイン情報が登録され、取得手順があるもの [{source, storeId, storeName}]。
 * 質問にサイト名（食べログ・一休）や店舗名が出てくればそれに絞る（絞ると空になる場合は絞らない）。
 */
export function selectTargets(question, available) {
  let list = (Array.isArray(available) ? available : []).filter((t) => LIVE_SOURCES.includes(t.source));
  const q = String(question ?? "").normalize("NFKC");
  const sites = [];
  if (/食べログ|たべログ|食べろぐ|tabelog/i.test(q)) sites.push("tabelog");
  if (/一休|いっきゅう|ikyu/i.test(q)) sites.push("ikyu");
  if (sites.length) { const bySite = list.filter((t) => sites.includes(t.source)); if (bySite.length) list = bySite; }
  const qs = [...storeNameVariants(q)];
  const names = [...new Set(list.map((t) => t.storeName).filter(Boolean))];
  const hit = names.filter((n) => storeKeys(n).some((k) => qs.some((x) => x.includes(k))));
  if (hit.length) list = list.filter((t) => hit.includes(t.storeName));
  return list.slice(0, LIVE_LIMITS.maxTargets).map((t) => ({ source: t.source, storeId: String(t.storeId ?? ""), storeName: clip(t.storeName, 100) }));
}

// 店舗名の一部（「カヴァカヴァ」「マルゴ」）でも当てる。ありふれた語だけでは当てない
const GENERIC_WORDS = new Set(["bistro", "bar", "restaurant", "cafe", "dining", "kitchen", "grill", "trattoria", "osteria", "ristorante", "store", "shop"]);
function storeKeys(name) {
  const keys = new Set([...storeNameVariants(name)].filter((v) => v.length >= 3));
  for (const word of String(name ?? "").normalize("NFKC").split(/[\s\u3000・･\-‐―_'’`.,、。&()「」!?/]+/)) {
    for (const v of storeNameVariants(word)) if (v.length >= 4 && !GENERIC_WORDS.has(v)) keys.add(v);
  }
  return [...keys];
}

/** 依頼の失敗理由を利用者向けに短く（Grok Bot の --fail の文）。 */
export function failureReason(error) {
  const s = clip(error, 300);
  if (!s) return "理由不明";
  if (/再ログイン|ログイン(?:でき|に失敗|切れ|が必要)|login|session/i.test(s)) return "要再ログイン";
  if (/追加認証|二段階|2段階|認証コード|captcha/i.test(s)) return "追加認証が必要";
  if (/24時間以内に取得されません/.test(s)) return "取得が始まりませんでした";
  if (/完了しませんでした（3回）/.test(s)) return "取得が完了しませんでした";
  if (/依頼できませんでした|依頼が多すぎ/.test(s)) return "取得を依頼できませんでした";
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** 取得の結果（targets × agent_requests）→ 回答の冒頭に足す文と、モデルへ渡す前提。 */
export function liveSummary(lookup, requests) {
  const byId = new Map((requests ?? []).map((r) => [String(r.id), r]));
  const ok = [], failed = [];
  let fetchedAt = null;
  for (const t of Array.isArray(lookup?.targets) ? lookup.targets : []) {
    const r = t.requestId ? byId.get(String(t.requestId)) : null;
    if (r && r.status === "done") {
      ok.push(t);
      if (r.finished_at && (!fetchedAt || ms(r.finished_at) > ms(fetchedAt))) fetchedAt = r.finished_at;
    } else {
      failed.push({ ...t, reason: failureReason(t.enqueueError ?? r?.error ?? (r ? "" : "依頼できませんでした")) });
    }
  }
  const lines = [`ご質問：「${excerpt(lookup?.question)}」`];
  const failText = failed.map((f) => `${SITE_LABELS[f.source] ?? f.source}（${clip(f.storeName, 100) || "店舗"}）: ${f.reason}`).join("／");
  if (ok.length) {
    lines.push(`サイトにログインして最新のデータを取得しました（${fetchedAt ? `${jst(fetchedAt)} 取得、` : ""}${describeTargets(ok)}）。`);
    if (failed.length) {
      const sites = [...new Set(failed.map((f) => SITE_LABELS[f.source] ?? f.source))].join("・");
      lines.push(`${failText} のため更新できませんでした。${sites}は前回までに取得したデータで答えています。`);
    }
  } else {
    lines.push(`最新のデータを取得できませんでした（${failText || "理由不明"}）。前回までに取得したデータで答えます。`);
  }
  const system = [
    "この質問のために、サイトにログインしてデータを取り直しました（取り直したデータはすでに関数の結果に入っています）。",
    ok.length ? `取り直せた: ${describeTargets(ok)}${fetchedAt ? `（${jst(fetchedAt)} 日本時間）` : ""}` : "取り直せたサイトはありません。",
    failed.length ? `取り直せなかった: ${failText}（そのサイトは前回までのデータ）。` : "",
    "取得できたかどうかの説明はシステムが回答の前に書き足すので、回答では繰り返さないでください。",
  ].filter(Boolean).join("\n");
  return { header: lines.join("\n"), system, ok, failed, fetchedAt, refreshedAny: ok.length > 0 };
}

const isExpiredChoice = (row, now) => row.status === "awaiting_choice" && ms(row.expires_at) <= now;
const choice2Allowed = (row, now) => {
  if (row.status === "awaiting_choice") return ms(row.expires_at) > now;
  if (["fetching", "timed_out", "failed"].includes(row.status)) return ms(row.chosen_at ?? row.created_at) + minutes(LIVE_LIMITS.choice2AfterFetchMinutes) > now;
  return false;
};

/**
 * /mtalk-chat の1回分。返り値は line_report へそのまま返す本文の一部:
 *   { mode, parts, choice?, live_start?: { lookup_id, deadline_seconds }, live_close?: [lookup_id] }
 * deps: { answer({ question, history, system? }) → { text }, now() }
 * input: { mtalkUserId, groupId, messageId, question, history, ownerUserId, liveAllowed }
 */
export async function handleMtalkTurn(store, deps, input) {
  const now = deps.now?.() ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const choice = parseChoice(input.question);
  const latest = await store.latestLookup(input.mtalkUserId, input.groupId);
  if (latest && isExpiredChoice(latest, now)) {
    await store.updateLookup(latest.id, ["awaiting_choice"], { status: "expired", finished_at: nowIso });
    latest.status = "expired";
  }

  if (choice === 2 && latest && choice2Allowed(latest, now)) {
    const from = latest.status;
    const claimed = await store.updateLookup(latest.id, [from], { status: "answering", answering_at: nowIso, ...(from === "awaiting_choice" ? { choice: 2, chosen_at: nowIso } : {}) });
    if (!claimed) return { mode: "busy", parts: ["いま回答を作っています。少しお待ちください。"] };
    try {
      const result = await deps.answer({ question: latest.question, history: latest.history ?? [] });
      await store.updateLookup(latest.id, ["answering"], { status: "answered", finished_at: new Date(deps.now?.() ?? Date.now()).toISOString() });
      const close = from === "awaiting_choice" ? {} : { live_close: [latest.id] };
      return { mode: "answer_now", text: `（今あるデータでの回答です）\n${result.text}`, ...close };
    } catch (error) {
      await store.updateLookup(latest.id, ["answering"], { status: "failed", error: clip(error?.message ?? "回答できませんでした", 300) });
      throw error;
    }
  }
  if (choice === 1 && latest && latest.status === "awaiting_choice") {
    if (!input.liveAllowed) return { mode: "guide", parts: ["この店舗のデータは、ここから最新を取り直せません。「2」を送ると今あるデータで答えます。"] };
    const targets = selectTargets(latest.question, await store.listTargets(input.ownerUserId));
    if (!targets.length) return { mode: "guide", parts: ["最新を取り直せるサイト（ログイン情報の登録）がありません。「2」を送ると今あるデータで答えます。"] };
    const deadline = new Date(now + minutes(LIVE_LIMITS.fetchMinutes)).toISOString();
    const claimed = await store.updateLookup(latest.id, ["awaiting_choice"], { status: "fetching", choice: 1, chosen_at: nowIso, deadline_at: deadline, targets });
    if (!claimed) return { mode: "busy", parts: ["いま調べています。終わったらお知らせします。"] };
    const done = [];
    for (const t of targets) {
      try { done.push({ ...t, requestId: (await store.enqueueRequest(input.ownerUserId, t, latest.id)).id }); }
      catch (error) { done.push({ ...t, enqueueError: clip(error?.message ?? "依頼できませんでした", 200) || "依頼できませんでした" }); }
    }
    const requested = done.filter((t) => t.requestId);
    if (!requested.length) {
      await store.updateLookup(latest.id, ["fetching"], { status: "awaiting_choice", choice: null, chosen_at: null, deadline_at: null, targets: [] });
      return { mode: "guide", parts: [`最新の取得を依頼できませんでした（${failureReason(done[0]?.enqueueError)}）。「2」を送ると今あるデータで答えます。`] };
    }
    await store.updateLookup(latest.id, ["fetching"], { targets: done, request_ids: requested.map((t) => t.requestId) });
    const notRequested = done.filter((t) => t.enqueueError);
    return {
      mode: "live_started",
      parts: [[
        `${LIVE_ACK}。`,
        `（対象: ${describeTargets(requested)}。5〜10分ほどかかります。${LIVE_LIMITS.fetchMinutes}分たっても終わらないときはお知らせします）`,
        ...(notRequested.length ? [`${describeTargets(notRequested)} は取得を依頼できなかったため、前回までのデータを使います。`] : []),
      ].join("\n")],
      live_start: { lookup_id: latest.id, deadline_seconds: LIVE_LIMITS.fetchMinutes * 60 },
    };
  }
  if (choice === 1 && latest && ["fetching", "answering"].includes(latest.status)) {
    return { mode: "busy", parts: [`いま調べています。終わったらお知らせします。待たずに今あるデータで答える場合は「2」を送ってください。`] };
  }
  if (choice) {
    return { mode: "guide", parts: ["選べる質問が見つかりませんでした（選択は30分で期限切れになります）。もう一度、質問を送ってください。"] };
  }

  // 新しい質問
  if (isChitChat(input.question) || !input.liveAllowed || !selectTargets(input.question, await store.listTargets(input.ownerUserId)).length) {
    return { mode: "direct" };
  }
  const active = latest && ACTIVE.includes(latest.status) ? latest : null;
  let replacedFetching = false;
  const closes = [];
  if (active) {
    const replaced = await store.updateLookup(active.id, ACTIVE, { status: "replaced", finished_at: nowIso });
    if (replaced && active.status !== "awaiting_choice") { replacedFetching = active.status === "fetching"; closes.push(active.id); }
  }
  const expiresAt = new Date(now + minutes(LIVE_LIMITS.choiceMinutes)).toISOString();
  const row = await store.insertLookup({
    owner_user_id: input.ownerUserId, mtalk_user_id: input.mtalkUserId, mtalk_group_id: input.groupId, message_id: input.messageId,
    question: input.question, history: input.history ?? [], status: "awaiting_choice", expires_at: expiresAt,
  });
  return { mode: "choice", ...choiceReply(input.question, { replacedFetching, expiresAt }), lookup_id: row.id, ...(closes.length ? { live_close: closes } : {}) };
}

/**
 * 「1」を選んだ質問のうち、取得依頼がすべて終わったものに答えて M-talk へ送る（agent-api が取得の完了・失敗・確認のたびに呼ぶ）。
 * deps: { answer({ question, history, system, lookup }) → { text }, post({ lookup, parts }) → any（409 = M-talk 側で時間切れ）, split(text) → parts, now() }
 */
export async function processLiveLookups(store, deps, ownerUserId) {
  const now = deps.now?.() ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const out = { checked: 0, answered: 0, waiting: 0, timedOut: 0, failed: 0, retry: 0 };
  for (const row of await store.openLiveLookups(ownerUserId)) {
    out.checked++;
    const stale = row.status === "answering" && ms(row.answering_at) + minutes(LIVE_LIMITS.answeringStaleMinutes) <= now;
    if (row.status === "answering" && !stale) continue;
    if (stale && (row.attempts ?? 0) >= LIVE_LIMITS.maxAttempts) {
      await store.updateLookup(row.id, ["answering"], { status: "failed", finished_at: nowIso, error: "回答を作れませんでした（3回）" });
      out.failed++; continue;
    }
    const requests = await store.requestsByIds(row.request_ids ?? []);
    const terminal = (row.request_ids ?? []).every((id) => { const r = requests.find((x) => String(x.id) === String(id)); return !r || r.status === "done" || r.status === "failed"; });
    if (!terminal) {
      if (row.deadline_at && ms(row.deadline_at) + minutes(LIVE_LIMITS.cleanupAfterDeadlineMinutes) <= now) {
        await store.updateLookup(row.id, ["fetching"], { status: "timed_out", finished_at: nowIso, error: "取得が時間内に終わりませんでした" });
        out.timedOut++;
      } else out.waiting++;
      continue;
    }
    const claimed = await store.updateLookup(row.id, [row.status], { status: "answering", answering_at: nowIso, attempts: (row.attempts ?? 0) + 1 });
    if (!claimed) continue;
    const summary = liveSummary(row, requests);
    let parts;
    try {
      const result = await deps.answer({ question: row.question, history: row.history ?? [], system: summary.system, lookup: row });
      parts = deps.split(`${summary.header}\n\n${result.text}`);
    } catch {
      parts = [`${summary.header}\n\nただ、回答を作れませんでした。「2」を送ると、${summary.refreshedAny ? "取り直した" : "今ある"}データで答えます。`];
      try { await deps.post({ lookup: row, parts }); } catch { /* 見張り（20分）に任せる */ }
      await store.updateLookup(row.id, ["answering"], { status: "failed", finished_at: new Date().toISOString(), error: "回答を作れませんでした" });
      out.failed++; continue;
    }
    try {
      await deps.post({ lookup: row, parts });
      await store.updateLookup(row.id, ["answering"], { status: "answered", finished_at: new Date(deps.now?.() ?? Date.now()).toISOString() });
      out.answered++;
    } catch (error) {
      if (error?.status === 409) {
        await store.updateLookup(row.id, ["answering"], { status: "timed_out", finished_at: nowIso, error: "M-talk 側で時間切れの案内を送り済み" });
        out.timedOut++;
      } else {
        await store.updateLookup(row.id, ["answering"], { status: "fetching" }); // 次の確認でやり直す（回数は attempts）
        out.retry++;
      }
    }
  }
  return out;
}

// ---------- Supabase（service_role）での読み書き ----------
const check = ({ data, error }) => { if (error) throw Object.assign(new Error(error.message ?? "db error"), { code: error.code }); return data; };
const LOOKUP_COLUMNS = "id,owner_user_id,mtalk_user_id,mtalk_group_id,message_id,question,history,status,choice,targets,request_ids,created_at,expires_at,chosen_at,deadline_at,answering_at,finished_at,attempts";

export function supabaseLiveStore(admin) {
  return {
    latestLookup: async (mtalkUserId, groupId) => (check(await admin.from("mtalk_live_lookups").select(LOOKUP_COLUMNS)
      .eq("mtalk_user_id", mtalkUserId).eq("mtalk_group_id", groupId).order("created_at", { ascending: false }).limit(1)) ?? [])[0] ?? null,
    // 状態が from のどれかのときだけ更新（同時に来た「1」の二重登録・遅れて届いた結果の上書きを防ぐ）
    updateLookup: async (id, from, patch) => (check(await admin.from("mtalk_live_lookups").update(patch).eq("id", id).in("status", from).select(LOOKUP_COLUMNS)) ?? [])[0] ?? null,
    insertLookup: async (row) => check(await admin.from("mtalk_live_lookups").insert(row).select(LOOKUP_COLUMNS).single()),
    openLiveLookups: async (ownerUserId) => check(await admin.from("mtalk_live_lookups").select(LOOKUP_COLUMNS)
      .eq("owner_user_id", ownerUserId).in("status", ["fetching", "answering"]).order("chosen_at").limit(20)) ?? [],
    requestsByIds: async (ids) => (ids.length ? check(await admin.from("agent_requests").select("id,source,store_id,status,error,finished_at,origin").in("id", ids)) : []) ?? [],
    // ログイン情報が登録された店舗×サイト（店舗名は「店舗とサイトの対応」から）
    listTargets: async (ownerUserId) => {
      const creds = check(await admin.from("credentials").select("source,store_key").eq("user_id", ownerUserId).in("source", LIVE_SOURCES)) ?? [];
      if (!creds.length) return [];
      const sites = check(await admin.from("store_sites").select("source,site_store_key,stores(name)").eq("user_id", ownerUserId).in("source", LIVE_SOURCES)) ?? [];
      return creds.map((c) => {
        const s = sites.find((x) => x.source === c.source && x.site_store_key === (c.store_key ?? ""));
        return { source: c.source, storeId: c.store_key ?? "", storeName: s?.stores?.name ?? "" };
      });
    },
    // 同じ店舗×サイトの未完了の依頼があればそれを使う（依頼中なら mtalk_live に格上げして夜間・優先でも拾われるようにする）
    enqueueRequest: async (ownerUserId, target, lookupId) => {
      const { data, error } = await admin.from("agent_requests").insert({
        user_id: ownerUserId, source: target.source, store_id: target.storeId, action: "sync_now", origin: "mtalk_live",
        params: { trigger: "mtalk_live", lookupId },
      }).select("id").single();
      if (!error) return data;
      if (error.code === "P0429") throw new LiveError("取得の依頼が多すぎるため依頼できませんでした", 429);
      if (error.code !== "23505") throw new LiveError("取得を依頼できませんでした", 500);
      const open = check(await admin.from("agent_requests").select("id,status,origin").eq("user_id", ownerUserId).eq("source", target.source)
        .eq("store_id", target.storeId).eq("action", "sync_now").in("status", ["queued", "claimed"]).limit(1)) ?? [];
      if (!open[0]) throw new LiveError("取得を依頼できませんでした", 500);
      if (open[0].status === "queued" && open[0].origin !== "mtalk_live") {
        check(await admin.from("agent_requests").update({ origin: "mtalk_live" }).eq("id", open[0].id).eq("status", "queued"));
      }
      return { id: open[0].id };
    },
  };
}
