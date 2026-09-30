// review-alerts.js の型（ブラウザ側 TypeScript 用。実装は JS の1か所だけ）
export type AlertRecipient = { id: string; name: string };
export type AlertSetting = { storeId: string; storeName: string; newReviews: boolean; scoreChanges: boolean; recipients: AlertRecipient[]; isDefault: boolean; updatedAt: string | null };
export type AlertSettingInput = { storeId: string; newReviews: boolean; scoreChanges: boolean; recipients: AlertRecipient[] };
export type AlertDelivery = { id: string; batchId: string; storeName: string | null; recipientId: string; recipientName: string | null; status: "sent" | "failed"; error: string | null; newReviews: number; scoreChanges: number; deduplicated: boolean; createdAt: string; updatedAt: string };
export type AlertEvent = { id: string; kind: "new_review" | "score_change"; source: string; storeKey: string; status: "pending" | "sending" | "sent" | "skipped" | "baseline" | "failed"; reason: string | null; createdAt: string; sentAt: string | null; summary: string };
export const ALERT_LIMITS: { reviewsPerMessage: number; textMax: number; titleMax: number; claim: number; maxAttempts: number; recipients: number; timeoutMs: number };
export const DEFAULT_ALERT_RECIPIENTS: readonly AlertRecipient[];
export const ALERT_STATUS_LABELS: Record<AlertEvent["status"], string>;
