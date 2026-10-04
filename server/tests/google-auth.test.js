import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { googleLoginOptions, readGoogleCallbackError } from "../../src/lib/google-auth.ts";

test("Google uses the exact gourmet root and no additional provider scopes", () => {
  const redirect = "https://marugo-s.github.io/gourmet/";
  assert.deepEqual(googleLoginOptions(redirect), { provider: "google", options: { redirectTo: redirect, skipBrowserRedirect: true } });
});
test("callback cancellation is safe Japanese text and retains unrelated routing", () => {
  const result = readGoogleCallbackError("https://marugo-s.github.io/gourmet/?view=accounts&error=access_denied&error_description=%3Cscript%3E#other=1");
  assert.match(result.message, /キャンセル/);
  assert.equal(result.cleanUrl, "/gourmet/?view=accounts#other=1");
  assert.doesNotMatch(result.message, /script/);
});
test("successful session/recovery callbacks are untouched", () => {
  assert.equal(readGoogleCallbackError("https://marugo-s.github.io/gourmet/#access_token=fake&refresh_token=fake&type=recovery"), null);
});
test("Google is opt-in and password login and owner authorization remain", async () => {
  const source = await readFile(new URL("../../src/components/LoginDialog.tsx", import.meta.url), "utf8");
  const config = await readFile(new URL("../../src/lib/supabase.ts", import.meta.url), "utf8");
  assert.match(config, /VITE_GOOGLE_AUTH_ENABLED === "true"/);
  assert.match(source, /signInWithPassword/);
  assert.match(source, /resetPasswordForEmail/);
  assert.match(source, /googleAuthEnabled && \(mode === "login" \|\| mode === "signup"\)/);
  assert.doesNotMatch(source, /(?:role|owner_id|store_id)\s*:\s*"admin"/);
});
