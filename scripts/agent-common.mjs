// 外部エージェント用スクリプトの共通処理。トークンは環境変数 INGEST_TOKEN または --token-file（chmod 600推奨）から読む。
// トークン・パスワードを標準出力やログに出さない。
import fs from "node:fs";

export const DEFAULT_ENDPOINT = "https://ycsqfajidusuibqljjwr.supabase.co/functions/v1/agent-api";

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    const value = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    args[key] = args[key] === undefined ? value : [].concat(args[key], value);
  }
  return args;
}

export function readToken(args, env = process.env) {
  if (typeof args["token-file"] === "string") return fs.readFileSync(args["token-file"], "utf8").trim();
  if (env.INGEST_TOKEN) return env.INGEST_TOKEN.trim();
  throw new Error("INGEST_TOKEN（環境変数）または --token-file を指定してください");
}

export async function callAgentApi(path, payload, { endpoint = DEFAULT_ENDPOINT, token, fetcher = fetch } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("agent-api はHTTPSで指定してください");
  const response = await fetcher(`${endpoint.replace(/\/$/, "")}${path}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { "Content-Type": "application/json", "X-Ingest-Token": token },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export const mask = (value) => {
  const s = String(value ?? "");
  if (!s) return "(なし)";
  return s.length <= 2 ? "*".repeat(s.length) : `${s[0]}${"*".repeat(Math.min(8, s.length - 2))}${s.at(-1)}`;
};
