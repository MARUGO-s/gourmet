// review-alerts.js の型（ブラウザ側 TypeScript 用。実装は JS の1か所だけ）
export type AlertBotMode = "auto" | "manual" | "none";
export type StoreBotRoom = { id: number; name: string; isStoreRoom: boolean; members: number | null };
export type StoreBot = { id: string; username: string; storeKey: string; rooms: StoreBotRoom[] };
export type AlertBot = { id: string; name: string; how: "exact" | "partial" | "manual" };
export type AlertSetting = {
  storeId: string; storeName: string; newReviews: boolean; scoreChanges: boolean;
  botMode: AlertBotMode; botId: string | null; botName: string | null; roomIds: number[] | null;
  bot: AlertBot | null; isDefault: boolean; updatedAt: string | null;
};
export type AlertSettingInput = { storeId: string; newReviews: boolean; scoreChanges: boolean; bot: { mode: AlertBotMode; id?: string; name?: string }; roomIds: number[] | null };
export type AlertDelivery = {
  id: string; batchId: string; storeName: string | null; recipientId: string; recipientName: string | null; status: "sent" | "failed"; error: string | null;
  newReviews: number; scoreChanges: number; deduplicated: boolean; target: "user" | "bot"; rooms: { id: number | null; name: string | null; deduplicated: boolean }[];
  createdAt: string; updatedAt: string;
};
export type AlertEvent = { id: string; kind: "new_review" | "score_change"; source: string; storeKey: string; status: "pending" | "sending" | "sent" | "skipped" | "baseline" | "failed"; reason: string | null; createdAt: string; sentAt: string | null; summary: string };
export const ALERT_LIMITS: { reviewsPerMessage: number; textMax: number; titleMax: number; claim: number; maxAttempts: number; rooms: number; timeoutMs: number };
export const ALERT_STATUS_LABELS: Record<AlertEvent["status"], string>;
export const NO_BOT_REASON: string;
export function matchStoreBot(storeName: string, bots: StoreBot[]): { bot: StoreBot; how: "exact" | "partial" } | null;
