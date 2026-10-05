export function googleLoginOptions(redirectTo: string) {
  return { provider: "google" as const, options: { redirectTo, skipBrowserRedirect: true } };
}

// Linking another Google account to the signed-in user (supabase.auth.linkIdentity). Same redirect and no extra scopes as login.
export const googleLinkOptions = googleLoginOptions;

const LINK_ERRORS: Record<string, string> = {
  identity_already_exists: "このGoogleアカウントは、すでに別のアカウントで使われています。そのアカウントを管理者が削除してから、もう一度連携してください。",
  manual_linking_disabled: "Googleアカウントの連携が有効になっていません。管理者へお問い合わせください。",
};
export function googleLinkErrorMessage(code: string | null | undefined) {
  return (code && LINK_ERRORS[code]) || "Googleアカウントを連携できませんでした。時間をおいてもう一度お試しください。";
}

// Emails of the Google identities on the signed-in user (supabase.auth.getUserIdentities).
export function googleIdentityEmails(identities: { provider: string; identity_data?: Record<string, unknown> | null }[]) {
  return identities.filter((i) => i.provider === "google").map((i) => String(i.identity_data?.email ?? "")).filter(Boolean);
}

// Do not render provider-supplied descriptions or erase a successful Auth token.
export function readGoogleCallbackError(href: string) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (!url.searchParams.has("error") && !hash.has("error")) return null;
  const cancelled = (url.searchParams.get("error") || hash.get("error")) === "access_denied";
  const code = url.searchParams.get("error_code") || hash.get("error_code");
  for (const key of ["error", "error_code", "error_description"]) {
    url.searchParams.delete(key);
    hash.delete(key);
  }
  url.hash = hash.toString();
  return {
    message: cancelled ? "Googleログインをキャンセルしました。もう一度お試しください。"
      : code && LINK_ERRORS[code] ? LINK_ERRORS[code]
      : "Googleログインできませんでした。もう一度お試しください。",
    cleanUrl: url.pathname + url.search + url.hash,
  };
}
