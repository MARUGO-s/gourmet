#!/usr/bin/env node
// 店舗×サイトの資格情報を agent-api から取得し、ローカルのキャッシュファイル（chmod 600）へ保存する。
//   INGEST_TOKEN=... node scripts/agent-credentials.mjs --source ikyu --store 112789 [--dir DIR] [--print-masked] [--force]
//   INGEST_TOKEN=... node scripts/agent-credentials.mjs --list        登録済みの一覧（版・更新日時のみ）
// 保存先: --dir または AGENT_CREDENTIAL_DIR（既定 ~/.review-agent/credentials）/<store>_<source>.json
// 平文のID・パスワードは標準出力に出さない。--print-masked は伏せ字の確認表示だけ。
// キャッシュの credentialsVersion がサーバーと同じ場合は再送されない（アプリで変更されると版が上がり再取得）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, readToken, callAgentApi, DEFAULT_ENDPOINT, mask } from "./agent-common.mjs";

export function cachePath(dir, source, storeKey) {
  if (!/^[a-z]+$/.test(source) || !/^[0-9A-Za-z_-]{0,40}$/.test(storeKey)) throw new Error("source / store が不正です");
  return path.join(dir, `${storeKey || "default"}_${source}.json`);
}

export function writeSecretFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function maskedSummary(cached) {
  const f = cached.fields ?? {};
  return Object.entries(f).map(([k, v]) => `${k}=${k === "password" ? "********" : mask(v)}`).join(" ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = args.endpoint || process.env.AGENT_API_URL || DEFAULT_ENDPOINT;
  const token = readToken(args);
  if (args.list) {
    const { status, body } = await callAgentApi("/credentials/versions", {}, { endpoint, token });
    if (status !== 200) throw new Error(`一覧を取得できませんでした（HTTP ${status}）`);
    for (const c of body.credentials) console.log(`${c.source}\t${c.storeKey || "(既定)"}\tv${c.credentialsVersion}\t${c.updatedAt}\t${c.label ?? ""}`);
    return;
  }
  const source = String(args.source ?? "");
  const storeKey = args.store === undefined ? "" : String(args.store);
  const dir = path.resolve(String(args.dir || process.env.AGENT_CREDENTIAL_DIR || path.join(os.homedir(), ".review-agent", "credentials")));
  const file = cachePath(dir, source, storeKey);
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cached = null; }
  const knownVersion = !args.force && cached?.credentialsVersion ? cached.credentialsVersion : null;
  const { status, body } = await callAgentApi("/credentials/fetch", { source, storeKey, knownVersion, agent: String(args.agent || "grok-bot") }, { endpoint, token });
  if (status !== 200) throw new Error(`資格情報を取得できませんでした（HTTP ${status}）: ${body.error ?? ""}`);
  if (body.unchanged) {
    console.log(`変更なし: ${file}（v${body.credentialsVersion}）`);
  } else {
    cached = { source: body.source, storeKey: body.storeKey, credentialsVersion: body.credentialsVersion, updatedAt: body.updatedAt, fetchedAt: new Date().toISOString(), fields: body.fields };
    writeSecretFile(file, cached);
    console.log(`保存しました: ${file}（v${body.credentialsVersion}、権限600）`);
  }
  if (args["print-masked"]) console.log(maskedSummary(cached));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message); process.exit(1); });
