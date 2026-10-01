// ログイン情報の問題（要再ログイン）をアプリで直すためのリンク（Node/Deno/ブラウザ共通の純粋モジュール）。
//
// ・パスワードは M-talk には書かせない・流さない。M-talk のボタンはアプリ（GitHub Pages）の画面を開くだけで、
//   入力はアプリにログインした本人が行う（review-api が本人の依頼・店舗×サイトであることを確かめる）。
// ・ボタンは failure_kind = needs_relogin のときだけ。needs_human_check（「私は人間です」の確認）は案内の文だけ（mtalk-live.js）。
// ・ログイン情報の更新: ?view=accounts&source=<サイト>&store=<店舗コード>&retry=<失敗した依頼> → アカウント管理の登録欄をその店舗×サイトで開く。
//   保存すると取り直しの依頼を登録する（retry が M-talk の「最新を調べる」の依頼なら、その結果をトークへ「再ログイン後の取得結果」として送る）。
import { APP_URL } from "./review-alerts.js";

export const LOGIN_LINK_LABELS = { relogin: "ログイン情報を更新" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_KEY = /^[0-9A-Za-z_-]{0,40}$/;
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const fail = (message) => { throw new Error(message); };
export const isUuid = (v) => typeof v === "string" && UUID.test(v);

/** ログイン情報の更新画面（アカウント管理）へのリンク。retry は失敗した依頼（任意）。 */
export function credentialUpdateUrl({ source, storeKey = "", retry = null }, appUrl = APP_URL) {
  if (typeof source !== "string" || !/^[a-z]{2,20}$/.test(source) || !STORE_KEY.test(String(storeKey ?? ""))) fail("リンクの店舗×サイトが不正です");
  const u = new URL(appUrl);
  u.searchParams.set("view", "accounts");
  u.searchParams.set("source", source);
  u.searchParams.set("store", String(storeKey ?? ""));
  if (retry != null) { if (!isUuid(retry)) fail("リンクの依頼が不正です"); u.searchParams.set("retry", retry.toLowerCase()); }
  return u.toString();
}

/**
 * アプリの URL の問い合わせ → 開く画面。不正な値は無視する（null）。
 *   { kind: "credentials", source, storeKey, retry }
 */
export function parseDeepLink(search) {
  let q;
  try { q = new URLSearchParams(String(search ?? "")); } catch { return null; }
  if (q.get("view") !== "accounts") return null;
  const source = q.get("source") ?? "", storeKey = q.get("store") ?? "", retry = q.get("retry");
  if (!/^[a-z]{2,20}$/.test(source) || !STORE_KEY.test(storeKey) || (source === "ikyu" && !/^\d{6}$/.test(storeKey))) return null;
  return { kind: "credentials", source, storeKey, retry: retry && isUuid(retry) ? retry.toLowerCase() : null };
}

/** アプリで開くための問い合わせ（使い終わったら URL から消す）。 */
export const DEEP_LINK_PARAMS = ["view", "source", "store", "retry"];

/**
 * 失敗した店舗×サイト → M-talk のボタン（ログインの問題だけ）。M-talk 側（line_report）がボタンの文を決め、URL を gourmet のアプリに限る。
 * failed: [{ source, storeId, storeName, requestId, kind }]
 */
export function loginLinks(failed, appUrl = APP_URL) {
  const out = [];
  for (const f of Array.isArray(failed) ? failed : []) {
    if (f?.kind !== "needs_relogin") continue;
    try {
      out.push({ kind: "relogin", source: f.source, store_name: String(f.storeName ?? "").replace(CONTROL, "").slice(0, 100),
        url: credentialUpdateUrl({ source: f.source, storeKey: f.storeId ?? "", retry: isUuid(f.requestId) ? f.requestId : null }, appUrl) });
    } catch { /* 店舗コードが不正なものはボタンを出さない */ }
  }
  const seen = new Set();
  return out.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true))).slice(0, 6);
}

