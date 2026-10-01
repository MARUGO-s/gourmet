// M-talk「AI分析」Bot の1対1（Node/Deno 共通）。
//
// 2026-10-01: 「1) サイトにログインして最新を調べる / 2) 今あるデータですぐ答える」の選択（カード）と、
// 「1」で取得依頼（agent_requests、origin = 'mtalk_live'）を登録して取得後に答える流れ・20分の見張りを廃止した。
// いまは、あいさつ・お礼（isChitChat）もデータの質問も、毎日の取り込み（確定値のキャッシュ）ですぐ答える（ai-analyst /mtalk-chat）。
// 答えには使ったサイトごとの鮮度（最後の取得日時・期間）が付く（data-freshness.js）。
//
// ここに残るもの:
//   ・古いカードのボタン（「1：サイトにログインして…」「2：今あるデータで…」）や「1」「2」だけの送信への対応（handleMtalkTurn）
//     → 2時間以内の質問が残っていればその質問にすぐ答える。無ければ「番号で選ぶ必要はなくなりました」と案内する
//   ・取得の失敗の文（failureReason）とログイン情報の案内（RELOGIN_GUIDE / HUMAN_CHECK_GUIDE。mtalk-followups.js・アプリの履歴で使う）
//   ・mtalk_live_lookups / agent_requests.origin = 'mtalk_live' の表・値は履歴のため残す（新しくは作らない）
import { SUPPORTED_SCHEDULE_SOURCES } from "./fetch-schedules.js";
import { classifyFailure } from "./agent-requests.js";
import { publicFailureLabel } from "./failure-text.js";

export const LIVE_LIMITS = {
  legacyAnswerMinutes: 120, // 古いボタンで、残っている質問に答える時間（質問から）
  answeringStaleMinutes: 5,
};
export const LIVE_SOURCES = SUPPORTED_SCHEDULE_SOURCES; // 取得手順があるサイト（食べログ・一休）
export const SITE_LABELS = { tabelog: "食べログ", ikyu: "一休", hotpepper: "ホットペッパー", google: "Google", toreta: "トレタ", retty: "Retty" };
export const CHOICE_RETIRED = "番号で選ぶ必要はなくなりました。質問をそのまま送ってください（毎日取り込んだデータで、すぐお答えします。答えの最後にデータの取得日時と期間を書きます）。";
// 古いボタンに答えるときの対象（答えた・取りやめた・回答作成中のものは除く）
const LEGACY_OPEN = ["awaiting_choice", "fetching", "timed_out", "failed", "expired"];
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

/**
 * 依頼の失敗 → 利用者向けの短い文。Grok Bot の --fail の理由の文はそのまま出さない（内部の言葉が混ざるため）。
 * kind = failure_kind（無い古い行だけ、理由の文から種類を判定する）。文は failure-text.js の決まった文だけ。
 */
export function failureReason(error, kind = null) {
  return publicFailureLabel(kind ?? classifyFailure(error));
}

// ボタン（links）を添えるときの案内。パスワード・確認コードはトークに書かないよう必ず添える
export const RELOGIN_GUIDE = "下の「ログイン情報を更新」からアプリで登録し直すと、取り直した結果をこのトークでお知らせします（パスワードはこのトークに書かないでください）。";
export const HUMAN_CHECK_GUIDE = "サイトがログインのときに「私は人間です」の確認を求めてきました。SiteBot（Grok Bot）が次の回に自動でやり直します。何度も続くときは、Grok Bot のアプリで SiteBot に伝えてください（SiteBot のパソコンで確認を済ませます）。";

/**
 * /mtalk-chat の1回分。
 *   ふつうの質問・あいさつ → { mode: "direct" }（呼び出し側がすぐ答える）
 *   古いボタン・「1」「2」だけ → 残っている質問があれば { mode: "answer_legacy", result }（その質問の答え）、無ければ { mode: "guide", parts }
 * deps: { answer({ question, history }) → { text, ... }, now() }
 * input: { mtalkUserId, groupId, messageId, question, history }
 */
export async function handleMtalkTurn(store, deps, input) {
  if (parseChoice(input.question) == null) return { mode: "direct" };
  const now = deps.now?.() ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const latest = await store.latestLookup(input.mtalkUserId, input.groupId);
  if (latest && LEGACY_OPEN.includes(latest.status) && ms(latest.created_at) + minutes(LIVE_LIMITS.legacyAnswerMinutes) > now) {
    const claimed = await store.updateLookup(latest.id, [latest.status], { status: "answering", answering_at: nowIso });
    if (!claimed) return { mode: "guide", parts: ["いま回答を作っています。少しお待ちください。"] };
    try {
      const result = await deps.answer({ question: latest.question, history: latest.history ?? [] });
      await store.updateLookup(latest.id, ["answering"], { status: "answered", finished_at: new Date(deps.now?.() ?? Date.now()).toISOString() });
      return { mode: "answer_legacy", result: { ...result, text: `ご質問：「${clip(latest.question, 60)}」\n${result.text}` } };
    } catch (error) {
      await store.updateLookup(latest.id, ["answering"], { status: "failed", finished_at: nowIso, error: clip(error?.message ?? "回答できませんでした", 300) });
      throw error;
    }
  }
  return { mode: "guide", parts: [CHOICE_RETIRED] };
}

// ---------- Supabase（service_role）での読み書き（古いボタンへの対応だけ） ----------
const check = ({ data, error }) => { if (error) throw Object.assign(new Error(error.message ?? "db error"), { code: error.code }); return data; };
const LOOKUP_COLUMNS = "id,owner_user_id,mtalk_user_id,mtalk_group_id,message_id,question,history,status,created_at,answering_at,finished_at,attempts";

export function supabaseLiveStore(admin) {
  return {
    latestLookup: async (mtalkUserId, groupId) => (check(await admin.from("mtalk_live_lookups").select(LOOKUP_COLUMNS)
      .eq("mtalk_user_id", mtalkUserId).eq("mtalk_group_id", groupId).order("created_at", { ascending: false }).limit(1)) ?? [])[0] ?? null,
    // 状態が from のどれかのときだけ更新（同時に来たボタンの二重回答を防ぐ）
    updateLookup: async (id, from, patch) => (check(await admin.from("mtalk_live_lookups").update(patch).eq("id", id).in("status", from).select(LOOKUP_COLUMNS)) ?? [])[0] ?? null,
  };
}
