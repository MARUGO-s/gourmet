import { supabase, supabaseUrl, publishableKey } from "./lib/supabase";
import type {
  CredentialRow,
  DashboardData,
  SourceMeta,
  SyncJob,
} from "./types";

// ログイン中のセッションがあれば Supabase JWT を API リクエストに転送する。
// 未ログインの場合はヘッダーなし（サーバーはデモデータで応答）。
async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return { apikey: publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  } catch {
    return { apikey: publishableKey };
  }
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const apiFetch = (path: string, options: RequestInit = {}) => fetch(
  `${supabaseUrl}/functions/v1/review-api${path.replace(/^\/api/, "")}`,
  { ...options, signal: options.signal ?? AbortSignal.timeout(30_000) },
);

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as { error?: string }).error ?? `通信に失敗しました（HTTP ${res.status}）`, res.status);
  }
  return res.json() as Promise<T>;
}

export async function getDashboard(source: "all" | string) {
  const headers = await authHeaders();
  return apiFetch(`/api/dashboard?source=${encodeURIComponent(source)}`, { headers }).then(
    (r) => json<DashboardData>(r),
  );
}

export async function getSources() {
  const headers = await authHeaders();
  return apiFetch("/api/sources", { headers }).then((r) => json<SourceMeta[]>(r));
}

export async function getCredentials() {
  const headers = await authHeaders();
  return apiFetch("/api/credentials", { headers }).then((r) => json<CredentialRow[]>(r));
}

export async function saveCredential(input: {
  source: string;
  label: string;
  username: string;
  password: string;
  storeId?: string;
}) {
  const headers = await authHeaders();
  return apiFetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  }).then((r) => json<{ ok: boolean }>(r));
}

export async function deleteCredential(id: string) {
  const headers = await authHeaders();
  return apiFetch(`/api/credentials/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers,
  }).then((r) => json<{ ok: boolean }>(r));
}

export async function syncNow(source: "all" | string) {
  const headers = await authHeaders();
  return apiFetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ source }),
    signal: AbortSignal.timeout(30_000),
  }).then((r) => json<SyncJob>(r));
}

export async function getSyncJob(id: string) {
  const headers = await authHeaders();
  return apiFetch(`/api/sync/jobs/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(30_000) })
    .then((r) => json<SyncJob>(r));
}

export async function getActiveSync() {
  const headers = await authHeaders();
  return apiFetch("/api/sync/active", { headers, signal: AbortSignal.timeout(30_000) })
    .then((r) => json<{ job: SyncJob | null }>(r));
}
