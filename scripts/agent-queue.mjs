#!/usr/bin/env node
// アプリからの取得依頼（agent_requests）を扱う。Grok Bot は約5分ごとに --claim して処理し、--complete / --fail で報告する。
//   node scripts/agent-queue.mjs --list [--source tabelog] [--origin mtalk_live]
//   node scripts/agent-queue.mjs --claim [--source tabelog] [--origin mtalk_live] [--limit 1] [--agent grok-bot]
//     --origin mtalk_live: M-talk の「最新を調べる」の依頼だけ（日本時間 9:00〜22:59 以外はこれだけ処理する）。指定が無くても mtalk_live が先に取得される
//   node scripts/agent-queue.mjs --complete <id> --claim-id <claimId> [--result '{"days":30}' | --result-file r.json]
//   node scripts/agent-queue.mjs --fail <id> --claim-id <claimId> --error "失敗の理由" [--kind needs_relogin | needs_human_check | other]
//     --kind: 失敗の種類。needs_relogin は、ブラウザの画面でサイトが「ID・パスワードが正しくありません」のようにはっきり表示したときだけ。
//       理由の文にそのサイトの表示を入れる（無いと agent-api が needs_relogin を認めず other にする）。M-talk・アプリに「ログイン情報を更新」のボタンが出る。
//     needs_human_check（「私は人間です」・Cloudflare の確認・画像パズル・2段階認証のコード）はボタンを出さず、次の回に自動でやり直すと案内する。
//     401・認証エラー・ログイン画面に戻された・原因不明は other。
//     省略すると理由の文から判定する（サイトの「正しくありません」→ needs_relogin、「私は人間です」「captcha」「認証コード」→ needs_human_check、それ以外 → other）
//   node scripts/agent-queue.mjs --enqueue-due [--limit 20] [--dry-run]   自動取得の設定のうち予定時刻を過ぎたものを取得依頼にする（--claim の前に実行）
// 共通: INGEST_TOKEN（環境変数）または --token-file、--endpoint / AGENT_API_URL。出力はJSON（秘密情報なし）。
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, readToken, callAgentApi, DEFAULT_ENDPOINT } from "./agent-common.mjs";

export const FAILURE_KINDS = ["needs_relogin", "needs_human_check", "other"];

export function queueCommand(args) {
  const one = (v) => (Array.isArray(v) ? v.at(-1) : v);
  const modes = ["list", "claim", "complete", "fail", "enqueue-due"].filter((m) => args[m] !== undefined);
  if (modes.length !== 1) throw new Error("--list / --claim / --complete / --fail / --enqueue-due のいずれか1つを指定してください");
  const mode = modes[0], source = typeof args.source === "string" ? args.source : undefined;
  const origin = args.origin === undefined ? undefined : one(args.origin);
  if (origin !== undefined && !["app", "schedule", "mtalk_live"].includes(origin)) throw new Error("--origin は app / schedule / mtalk_live です");
  if (origin !== undefined && mode !== "list" && mode !== "claim") throw new Error("--origin は --list / --claim で使います");
  if (mode === "enqueue-due") {
    const limit = args.limit === undefined ? undefined : Number(one(args.limit));
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) throw new Error("--limit は1〜50です");
    return { path: "/schedules/enqueue-due", body: { ...(limit !== undefined ? { limit } : {}), ...(args["dry-run"] !== undefined ? { dryRun: true } : {}) } };
  }
  if (mode === "list") return { path: "/requests/pending", body: { ...(source ? { source } : {}), ...(origin ? { origin } : {}) } };
  if (mode === "claim") {
    const limit = args.limit === undefined ? 1 : Number(one(args.limit));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("--limit は1〜20です");
    return { path: "/requests/claim", body: { agent: typeof args.agent === "string" ? args.agent : "grok-bot", limit, ...(source ? { source } : {}), ...(origin ? { origin } : {}) } };
  }
  const id = one(args[mode]), claimId = one(args["claim-id"]);
  if (typeof id !== "string" || typeof claimId !== "string") throw new Error(`--${mode} <id> と --claim-id <claimId> を指定してください`);
  if (args.kind !== undefined && mode !== "fail") throw new Error("--kind は --fail で使います");
  let result;
  if (typeof args["result-file"] === "string") result = JSON.parse(fs.readFileSync(args["result-file"], "utf8"));
  else if (typeof args.result === "string") result = JSON.parse(args.result);
  if (mode === "complete") return { path: "/requests/complete", body: { id, claimId, result: result ?? {} } };
  if (typeof args.error !== "string" || !args.error.trim()) throw new Error("--error で失敗の理由を指定してください");
  const kind = args.kind === undefined ? undefined : one(args.kind);
  if (kind !== undefined && !FAILURE_KINDS.includes(kind)) throw new Error(`--kind は ${FAILURE_KINDS.join(" / ")} です`);
  return { path: "/requests/fail", body: { id, claimId, error: args.error, ...(kind ? { failureKind: kind } : {}), ...(result ? { result } : {}) } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { path, body } = queueCommand(args);
    const { status, body: response } = await callAgentApi(path, body, { endpoint: args.endpoint || process.env.AGENT_API_URL || DEFAULT_ENDPOINT, token: readToken(args) });
    if (status !== 200) { console.error(`失敗しました（HTTP ${status}）: ${response.error ?? ""}`); process.exit(1); }
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
