import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as storeHelpers from "../../supabase/functions/_shared/stores.js";
import { CREDENTIAL_METADATA_COLUMNS, publicCredentialMetadata } from "../../supabase/functions/_shared/credential-metadata.js";

const row = { id: "credential", user_id: "owner", source: "ikyu", label: "Bistro", store_key: "112789", credentials_version: 2, updated_at: "2026-10-07", username: "secret-login", password_enc: "secret-cipher" };
test("shared credential metadata whitelists safe fields and preserves owner-only deletion", () => {
  const shared = publicCredentialMetadata(row, "another-admin");
  assert.deepEqual(shared, { id: "credential", source: "ikyu", label: "Bistro", storeKey: "112789", credentialsVersion: 2, updatedAt: "2026-10-07", canDelete: false });
  assert.equal(publicCredentialMetadata(row, "owner").canDelete, true);
  assert.equal(publicCredentialMetadata(row, null).canDelete, false);
  assert.doesNotMatch(JSON.stringify(shared), /secret|user_id|username|password/);
  assert.doesNotMatch(CREDENTIAL_METADATA_COLUMNS, /username|password/);
});
test("metadata sharing adds only admin SELECT, without secret grants or broader writes", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/027_gourmet_shared_credential_metadata.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "");
  assert.match(sql, /for select to authenticated\s+using \(\(select public\.gourmet_is_admin\(\)\)\)/);
  assert.doesNotMatch(sql, /grant|for all|for update|for delete|for insert|drop policy|disable row/i);
});
test("account list exposes deletion only for owned rows, not shared or older responses", () => {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL("../../src/components/CredentialsPanel.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  let hook = 0;
  const rows = [publicCredentialMetadata(row, "owner"), { ...publicCredentialMetadata(row, "another-admin"), id: "shared" }, { ...row, id: "old-response" }];
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return { useState: init => [hook++ === 0 ? rows : typeof init === "function" ? init() : init, () => {}], useEffect() {}, useCallback: fn => fn };
    if (name === "../api") return {};
    if (name.endsWith("stores.js")) return storeHelpers;
    if (name === "./StorePicker") return { default() {}, emptyPick: storeId => ({ storeId, key: "" }) };
    throw new Error(`Unexpected import ${name}`);
  } });
  const tree = module.exports.default({ sources: [], stores: [], scopeKeys: null, defaultStoreId: "", onChanged() {}, onStoresChanged() {} });
  const flatten = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(flatten)];
  const nodes = flatten(tree);
  assert.equal(nodes.filter(n => n.type === "button" && n.props.children === "削除").length, 1);
  assert.equal(nodes.filter(n => n.type === "span" && n.props.children === "他の管理者が登録（閲覧のみ）").length, 2);
});
