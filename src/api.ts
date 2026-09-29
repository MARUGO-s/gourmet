import { supabase, supabaseUrl, publishableKey } from "./lib/supabase";
import type {
  CredentialRow,
  DashboardData,
  SourceMeta,
  AgentRequest,
  AgentRequestAction,
  FetchSchedule,
  ScheduleInput,
  Store,
  StoreSite,
  Overview,
  AiStatus,
  AiAskResult,
  AiReport,
  AiReportSummary,
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

// store: 'all'（全店舗）/ 店舗ID / 'unassigned'。未ログイン（デモ）では無視される
export async function getDashboard(source: "all" | string, store = "all") {
  const headers = await authHeaders();
  return apiFetch(`/api/dashboard?source=${encodeURIComponent(source)}&store=${encodeURIComponent(store)}`, { headers }).then(
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
  storeKey?: string;
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

// Grok Bot への取得依頼（本人の依頼だけ。状態の変更はエージェント側のみ）
export async function getRequests() {
  const headers = await authHeaders();
  return apiFetch("/api/requests", { headers }).then((r) => json<{ requests: AgentRequest[] }>(r));
}

export async function createRequest(input: { source: string; storeId: string; action: AgentRequestAction; params?: { fromMonth?: string; note?: string } }) {
  const headers = await authHeaders();
  return apiFetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  }).then((r) => json<{ request: AgentRequest }>(r));
}

// 自動取得の設定（店舗×サイト）。予定時刻を過ぎた設定はGrok Botが取得依頼にする
export async function getSchedules() {
  const headers = await authHeaders();
  return apiFetch("/api/schedules", { headers }).then((r) => json<{ schedules: FetchSchedule[] }>(r));
}

export async function saveSchedule(input: ScheduleInput) {
  const headers = await authHeaders();
  return apiFetch("/api/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  }).then((r) => json<{ schedule: FetchSchedule }>(r));
}

export async function deleteSchedule(id: string) {
  const headers = await authHeaders();
  return apiFetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE", headers }).then((r) => json<{ ok: boolean }>(r));
}

// 店舗マスタ（店舗ごとに各サイトの店舗IDをまとめる）。表示の絞り込み用で、権限ではない
const postJson = async <T>(path: string, value: unknown) => {
  const headers = await authHeaders();
  return apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) }).then((r) => json<T>(r));
};
const del = async (path: string) => {
  const headers = await authHeaders();
  return apiFetch(path, { method: "DELETE", headers }).then((r) => json<{ ok: boolean }>(r));
};

export async function getStores() {
  const headers = await authHeaders();
  return apiFetch("/api/stores", { headers }).then((r) => json<{ stores: Store[] }>(r));
}
export const createStore = (input: { name: string; sortOrder?: number }) => postJson<{ store: Store }>("/api/stores", input);
export const updateStore = (id: string, input: { name?: string; sortOrder?: number }) => postJson<{ store: Store }>(`/api/stores/${encodeURIComponent(id)}`, input);
export const reorderStores = (ids: string[]) => postJson<{ stores: Store[] }>("/api/stores/reorder", { ids });
export const deleteStore = (id: string) => del(`/api/stores/${encodeURIComponent(id)}`);
export const addStoreSite = (storeId: string, input: { source: string; siteStoreKey: string }) =>
  postJson<{ site: StoreSite }>(`/api/stores/${encodeURIComponent(storeId)}/sites`, input);
export const deleteStoreSite = (storeId: string, siteId: string) => del(`/api/stores/${encodeURIComponent(storeId)}/sites/${encodeURIComponent(siteId)}`);

export async function getOverview(month?: string) {
  const headers = await authHeaders();
  return apiFetch(`/api/overview${month ? `?month=${encodeURIComponent(month)}` : ""}`, { headers }).then((r) => json<{ overview: Overview }>(r));
}

// AI分析（ai-analyst）。OpenAIのAPIキーはサーバー（Edge Functionの秘密情報）だけにあり、ブラウザは本人のJWTでこの関数だけを呼ぶ。
// 回答・レポートの作成は時間がかかるため、タイムアウトを長くする。
const aiFetch = async <T>(path: string, options: RequestInit = {}, timeoutMs = 30_000) => {
  const headers = await authHeaders();
  const res = await fetch(`${supabaseUrl}/functions/v1/ai-analyst${path}`, {
    ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...headers }, signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: unknown) => {
    throw new ApiError(e instanceof DOMException && e.name === "TimeoutError" ? "AIの応答が時間内に返りませんでした。期間を短くしてお試しください" : "通信に失敗しました", 0);
  });
  return json<T>(res);
};
export const getAiStatus = () => aiFetch<AiStatus>("/status");
export const askAi = (input: { question: string; storeId: string; from: string; to: string; history: { role: "user" | "assistant"; content: string }[] }) =>
  aiFetch<AiAskResult>("/ask", { method: "POST", body: JSON.stringify(input) }, 150_000);
export const getAiReports = () => aiFetch<{ reports: AiReportSummary[] }>("/reports");
export const getAiReport = (id: string) => aiFetch<{ report: AiReport }>(`/reports/${encodeURIComponent(id)}`);
export const createAiReport = (input: { storeId: string; from: string; to: string; title?: string; focus?: string }) =>
  aiFetch<{ report: AiReport }>("/reports", { method: "POST", body: JSON.stringify(input) }, 160_000);
export const deleteAiReport = (id: string) => aiFetch<{ ok: boolean }>(`/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
