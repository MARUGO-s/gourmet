export function googleLoginOptions(redirectTo: string) {
  return { provider: "google" as const, options: { redirectTo, skipBrowserRedirect: true } };
}

// Do not render provider-supplied descriptions or erase a successful Auth token.
export function readGoogleCallbackError(href: string) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (!url.searchParams.has("error") && !hash.has("error")) return null;
  const cancelled = (url.searchParams.get("error") || hash.get("error")) === "access_denied";
  for (const key of ["error", "error_code", "error_description"]) {
    url.searchParams.delete(key);
    hash.delete(key);
  }
  url.hash = hash.toString();
  return {
    message: cancelled ? "Googleログインをキャンセルしました。もう一度お試しください。" : "Googleログインできませんでした。もう一度お試しください。",
    cleanUrl: url.pathname + url.search + url.hash,
  };
}
