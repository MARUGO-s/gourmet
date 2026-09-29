// fetch-schedules.js の型（ブラウザ側 TypeScript 用。実装は JS の1か所だけ）
export type ScheduleMode = "off" | "hourly_interval" | "daily" | "weekly";
export type ScheduleRow = {
  id?: string; source: string; store_id: string; mode: ScheduleMode; enabled?: boolean;
  interval_hours?: number | null; time_of_day?: string | null; weekday?: number | null;
  last_enqueued_at?: string | null; last_request_id?: string | null; next_due_at?: string | null; updated_at?: string | null;
};
export type ScheduleInput = { source: string; storeId?: string; mode?: ScheduleMode; enabled?: boolean; intervalHours?: number; timeOfDay?: string; weekday?: number };
export type PublicSchedule = {
  id: string; source: string; storeId: string; mode: ScheduleMode; intervalHours: number | null; timeOfDay: string | null; weekday: number | null;
  enabled: boolean; supported: boolean; lastEnqueuedAt: string | null; lastRequestId: string | null; nextDueAt: string | null; updatedAt: string | null;
};
export const SCHEDULE_SOURCES: string[];
export const SUPPORTED_SCHEDULE_SOURCES: string[];
export const SCHEDULE_MODES: ScheduleMode[];
export const MODE_LABELS: Record<ScheduleMode, string>;
export const WEEKDAY_LABELS: string[];
export const INTERVAL_CHOICES: number[];
export const MAX_INTERVAL_HOURS: number;
export const AGENT_WINDOW: { startHour: number; endHour: number };
export const AGENT_WINDOW_NOTE: string;
export const ENQUEUE_LIMIT: number;
export function parseTimeOfDay(value: unknown): number | null;
export function japanHour(now: Date | string | number): number;
export function inAgentWindow(now: Date | string | number): boolean;
export function timeOutsideAgentWindow(timeOfDay: string | null | undefined): boolean;
export function computeNextDue(schedule: Partial<ScheduleRow> & { mode: ScheduleMode }, now: Date | string | number, anchor?: Date | string | null): string | null;
export function validateScheduleInput(input: unknown): Omit<ScheduleRow, "id">;
export function nextDueOnSave(row: Partial<ScheduleRow> & { mode: ScheduleMode }, now: Date | string | number, lastEnqueuedAt?: string | null): string | null;
export function describeSchedule(s: Partial<PublicSchedule> | Partial<ScheduleRow>): string;
export function publicSchedule(r: ScheduleRow): PublicSchedule;
export function enqueueDueSchedules(store: unknown, options?: { now?: Date | string; limit?: number; dryRun?: boolean }): Promise<unknown>;
export function supabaseScheduleStore(admin: unknown, userId: string): unknown;
