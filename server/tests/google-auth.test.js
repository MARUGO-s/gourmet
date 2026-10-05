import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { googleIdentityEmails, googleLinkErrorMessage, googleLinkOptions, googleLoginOptions, readGoogleCallbackError } from "../../src/lib/google-auth.ts";

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
test("linking another Google account: same redirect/no extra scopes, fixed Japanese errors, lists only Google identities", async () => {
  const redirect = "https://marugo-s.github.io/gourmet/";
  assert.deepEqual(googleLinkOptions(redirect), googleLoginOptions(redirect));
  assert.match(googleLinkErrorMessage("identity_already_exists"), /すでに別のアカウントで使われています/);
  assert.match(googleLinkErrorMessage("manual_linking_disabled"), /連携が有効になっていません/);
  assert.match(googleLinkErrorMessage(undefined), /連携できませんでした/);
  assert.deepEqual(googleIdentityEmails([
    { provider: "email", identity_data: { email: "owner@example.com" } },
    { provider: "google", identity_data: { email: "owner@example.com" } },
    { provider: "google", identity_data: { email: "staff@example.com" } },
    { provider: "google", identity_data: null },
  ]), ["owner@example.com", "staff@example.com"]);
  // 連携の失敗から戻ったとき（error_code=identity_already_exists）は理由を固定の文で出し、提供元の説明は出さない
  const back = readGoogleCallbackError("https://marugo-s.github.io/gourmet/?error=server_error&error_code=identity_already_exists&error_description=%3Cb%3Ex%3C%2Fb%3E");
  assert.match(back.message, /すでに別のアカウントで使われています/);
  assert.equal(back.cleanUrl, "/gourmet/");
  const source = await readFile(new URL("../../src/components/LoginDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /supabase\.auth\.linkIdentity\(googleLinkOptions\(authRedirect\(\)\)\)/);
  assert.match(source, /\{googleAuthEnabled && <button onClick=\{\(\) => \{ setLinkMessage\(""\); void openLink\(\); \}\}[^\n]*>Google連携<\/button>\}/);
});
