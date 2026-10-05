// weekly-schedules.js の型（ブラウザ側 TypeScript 用。実装は JS の1か所だけ）
export type WeeklyStatus = "delivered" | "skipped" | "deferred" | "failed";
export type WeeklyScheduleInput = { storeId: string; weekday?: number; timeOfDay?: string; enabled?: boolean; roomIds?: number[] | null; includePdf?: boolean };
export type PublicWeeklySchedule = {
  id: string; storeId: string; storeName: string | null; weekday: number; timeOfDay: string | null; enabled: boolean;
  roomIds: number[] | null; includePdf: boolean; nextDueAt: string | null; slotAt: string | null; asOf: string | null;
  attempts: number; working: boolean; lastStatus: WeeklyStatus | null; lastReason: string | null; lastAsOf: string | null;
  lastHtmlUrl: string | null; lastCardMessageIds: number[]; lastFinishedAt: string | null; lastDeliveredAt: string | null; updatedAt: string | null;
};
export const WEEKLY_SCHEDULE_DEFAULT: { weekday: number; timeOfDay: string; enabled: boolean; includePdf: boolean };
export const WEEKLY_CLAIM_MINUTES: number;
export const WEEKLY_RETRY_MINUTES: number;
export const WEEKLY_MAX_ATTEMPTS: number;
export const WEEKLY_MAX_ROOMS: number;
export const WEEKLY_OUTCOMES: WeeklyStatus[];
export const WEEKLY_STATUS_LABELS: Record<WeeklyStatus, string>;
export const WEEKLY_PAGES_PREFIX: string;
export function japanDateOf(value: Date | string | number): string;
export function weeklyNextDue(row: { weekday: number; time_of_day?: string | null; timeOfDay?: string | null; enabled?: boolean }, now: Date | string | number): string | null;
export function validateWeeklyScheduleInput(input: unknown, storeIds?: string[] | null): Record<string, unknown>;
export function weeklySchedulePatchOnSave(row: Record<string, unknown>, now: Date | string | number): Record<string, unknown>;
export function parseRoomIds(text: string | null | undefined): number[] | null;
export function describeWeeklySchedule(s: Partial<PublicWeeklySchedule> | { weekday?: number | null; time_of_day?: string | null }): string;
export function publicWeeklySchedule(r: Record<string, unknown>, store?: { name: string } | null): PublicWeeklySchedule;
export function isWeeklyDue(r: Record<string, unknown>, now: Date | string | number): boolean;
