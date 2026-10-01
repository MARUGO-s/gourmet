// failure-text.js の型（ブラウザから使う部分）
export const PUBLIC_FAILURE_LABELS: Record<"needs_relogin" | "needs_human_check" | "other" | "unfinished" | "not_queued", string>;
export function publicFailureLabel(kind: string | null | undefined): string;
export function publicFailureText(input: { site: string; storeName?: string | null; kind: string | null | undefined }): string;
export const INTERNAL_TERMS: RegExp;
export function hasInternalTerms(text: unknown): boolean;
export function scrubInternal(text: unknown): string;
export const SCRUBBED_FALLBACK: string;
export function safeParts(parts: unknown): string[];
