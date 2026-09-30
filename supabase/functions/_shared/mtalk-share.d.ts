// mtalk-share.js の型（ブラウザ側 TypeScript 用。カードのプレビューに使う部分だけ）
export type ShareCardData = {
  title: string;
  sender_label: string;
  card: { subtitle: string; fields: { label: string; value: string }[]; highlights: string[]; recommendations: string[] };
};
export const MTALK_SHARE_LIMITS: { perHour: number; timeoutMs: number; pdfMaxBytes: number };
export function buildShareCard(report: { title: string; storeName: string; from: string; to: string; createdAt?: string; content?: unknown }, options: { sender: string }): ShareCardData;
export function senderLabel(user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined): string;
export function shareFileName(report: { storeName?: string; from?: string; to?: string }): string;
