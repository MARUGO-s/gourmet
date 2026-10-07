import assert from "node:assert/strict";
import test from "node:test";
import { authErrorMessage } from "../../src/lib/auth-errors.ts";

test("weak passwords explain the reason and next action, even above eight characters", () => {
  const message = authErrorMessage({ code: "weak_password" });
  assert.match(message, /推測されやすい/);
  assert.match(message, /8文字以上でも/);
  assert.match(message, /変更してください/);
  assert.match(authErrorMessage({ code: "weak_password", reasons: ["pwned"] }), /流出したパスワードと一致/);
  assert.match(authErrorMessage({ code: "weak_password", reasons: ["length"] }), /短すぎます/);
  assert.match(authErrorMessage({ code: "weak_password", reasons: ["characters"] }), /必要な種類/);
});

test("known authentication failures have specific fixed guidance", () => {
  for (const [code, expected] of [
    ["invalid_credentials", /Googleで登録/], ["email_not_confirmed", /確認メール/],
    ["user_already_exists", /ログインに戻る/], ["email_exists", /登録済み/],
    ["over_email_send_rate_limit", /メール送信/], ["over_request_rate_limit", /一時的に制限/],
    ["email_address_invalid", /形式が正しくありません/], ["signup_disabled", /受付が停止/],
  ]) assert.match(authErrorMessage({ code }), expected);
});

test("unknown or malformed errors do not expose provider messages or sensitive input", () => {
  for (const error of [null, undefined, "secret", {}, { code: "unknown", message: "secret<script>" }, { code: "weak_password", reasons: "secret" }]) {
    assert.doesNotMatch(authErrorMessage(error), /secret|script/);
    assert.ok(authErrorMessage(error).length > 10);
  }
});
