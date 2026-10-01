// login-help.js の型（ブラウザから使う部分）
export type DeepLink = { kind: "credentials"; source: string; storeKey: string; retry: string | null } | null;
export const LOGIN_LINK_LABELS: { relogin: string };
export const DEEP_LINK_PARAMS: string[];
export function isUuid(v: unknown): boolean;
export function credentialUpdateUrl(input: { source: string; storeKey?: string; retry?: string | null }, appUrl?: string): string;
export function parseDeepLink(search: string): DeepLink;
export function loginLinks(failed: unknown[], appUrl?: string): { kind: "relogin"; source: string; store_name: string; url: string }[];
