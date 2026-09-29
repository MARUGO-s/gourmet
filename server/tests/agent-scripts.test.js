import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachePath, writeSecretFile, maskedSummary } from "../../scripts/agent-credentials.mjs";
import { callAgentApi, mask, parseArgs, readToken } from "../../scripts/agent-common.mjs";

test("credential cache files are written with 600 permissions in a 700 directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cred-"));
  const file = cachePath(path.join(dir, "credentials"), "ikyu", "112789");
  assert.equal(path.basename(file), "112789_ikyu.json");
  writeSecretFile(file, { credentialsVersion: 2, fields: { storeId: "112789", operatorId: "operator", password: "s3cret-value" } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).credentialsVersion, 2);
  assert.throws(() => cachePath(dir, "ikyu", "../etc"), /不正/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("masked output never contains the password or the full operator id", () => {
  const text = maskedSummary({ fields: { storeId: "112789", operatorId: "operator", password: "s3cret-value" } });
  assert.ok(!text.includes("s3cret") && !text.includes("=operator"));
  assert.match(text, /password=\*{8}/);
  assert.equal(mask("ab"), "**");
});

test("the token goes only in the dedicated header, over HTTPS", async () => {
  let seen;
  const fetcher = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  const res = await callAgentApi("/ikyu/ingest", { a: 1 }, { endpoint: "https://example.supabase.co/functions/v1/agent-api", token: "t".repeat(40), fetcher });
  assert.equal(res.status, 200);
  assert.equal(seen.url, "https://example.supabase.co/functions/v1/agent-api/ikyu/ingest");
  assert.equal(seen.init.headers["X-Ingest-Token"], "t".repeat(40));
  assert.ok(!seen.init.body.includes("tttt"));
  await assert.rejects(() => callAgentApi("/x", {}, { endpoint: "http://example.com/agent-api", token: "t", fetcher }), /HTTPS/);
  assert.deepEqual(parseArgs(["a.json", "--pv", "2026-09=a", "--pv", "2026-08=b", "--dry-run"]), { _: ["a.json"], pv: ["2026-09=a", "2026-08=b"], "dry-run": true });
  assert.throws(() => readToken({}, {}), /INGEST_TOKEN/);
});
