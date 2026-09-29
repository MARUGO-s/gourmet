import type { AgentRequest, AgentRequestAction, AgentRequestStatus } from "../types";

// supabase/functions/_shared/agent-requests.js と同じ表示（テストで一致を確認）
export const STATUS_LABELS: Record<AgentRequestStatus, string> = { queued: "依頼中", claimed: "取得中", done: "完了", failed: "失敗" };
export const ACTION_LABELS: Record<AgentRequestAction, string> = {
  sync_now: "今すぐ取得（全項目）", fetch_metrics: "PV・予約などの数値", fetch_reviews: "口コミ", backfill: "過去分の取得",
};
export const AGENT_POLL_MINUTES = 5;
export const INGEST_NOTE = "データはGrok Botが取り込み";

export const requestLabel = (status: AgentRequestStatus) => STATUS_LABELS[status] ?? status;
export const isOpen = (r: Pick<AgentRequest, "status">) => r.status === "queued" || r.status === "claimed";

type Key = Pick<AgentRequest, "source" | "storeId" | "action" | "status">;
export function openRequestFor<T extends Key>(rows: T[], source: string, storeId: string, action: AgentRequestAction = "sync_now") {
  return rows.find((r) => r.source === source && r.storeId === storeId && r.action === action && isOpen(r));
}
export const hasOpenRequests = (rows: Pick<AgentRequest, "status">[]) => rows.some(isOpen);

export const statusTone = (status: AgentRequestStatus) =>
  status === "done" ? "bg-ok-soft text-ok" : status === "failed" ? "bg-danger-soft text-danger" : status === "claimed" ? "bg-brand-soft text-brand" : "bg-warn-soft text-warn";

export const formatTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }) : "—";
