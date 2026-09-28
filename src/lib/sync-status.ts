export type SyncState = {
  phase: "idle" | "submitting" | "queued" | "fetching";
  busy: boolean;
  label: string;
  animate: boolean;
};

// The database's running status includes queued jobs. Only a claimed job is fetching.
export function getSyncState(job: { status: string; step: string } | null, submitting = false): SyncState {
  if (submitting) return { phase: "submitting", busy: true, label: "依頼を送信中…", animate: true };
  if (job?.status !== "running") return { phase: "idle", busy: false, label: "今すぐ同期", animate: false };
  if (job.step === "queued") return { phase: "queued", busy: true, label: "開始待ち", animate: false };
  return { phase: "fetching", busy: true, label: "取得中…", animate: true };
}
