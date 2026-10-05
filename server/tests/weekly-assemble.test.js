// 週報の入力を実取得データから組み立てる（scripts/shared/weekly-sources.js・weekly-assemble.mjs）。
// stub（手書きの薄い入力）を検出して --send / Pages 公開を止める。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleIkyuSources, assembleTabelogSources, discoverRunFiles, looksSynthetic, payloadProblem, sendBlockers } from "../../scripts/shared/weekly-sources.js";
import { runWeeklyAssemble } from "../../scripts/weekly-assemble.mjs";
import { runWeeklyDeliver } from "../../scripts/weekly-deliver.mjs";

test("looksSynthetic: 周期的・等差の日別 PV を stub と判定する", () => {
  assert.equal(looksSynthetic([100, 110, 120, 130, 140, 150, 160, 100, 110, 120, 130, 140, 150, 160]), true);
  assert.equal(looksSynthetic([20, 21, 22, 23, 24, 20, 21, 22, 23, 24, 20, 21, 22, 23, 24]), true);
  assert.equal(looksSynthetic([174, 102, 170, 112, 258, 98, 132, 254, 140, 99, 188, 121, 95, 210]), false);
});

test("payloadProblem: 取り込み JSON だけを受け、runId=t・合成日別を拒否する", () => {
  const real = { schemaVersion: 1, source: "tabelog", runId: "tabelog-13245351-20261005015048", agent: "grok-bot", capturedAt: "2026-10-05T01:50:48.776Z", stores: [{ storeKey: "13245351", daily: [{ date: "2026-09-01", pv: 174 }, { date: "2026-09-02", pv: 102 }] }] };
  assert.equal(payloadProblem(real), null);
  assert.match(payloadProblem({ ...real, runId: "t" }), /runId/);
  assert.match(payloadProblem({ ...real, agent: "" }), /agent/);
  const stubDaily = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, pv: 100 + (i % 7) * 10 }));
  assert.match(payloadProblem({ ...real, stores: [{ storeKey: "13245351", daily: stubDaily }] }), /合成/);
});

test("discoverRunFiles: 配信の出力フォルダを飛ばし、payload・owner-home・ランキングを拾う", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-discover-"));
  fs.mkdirSync(path.join(root, "run-a", "pages"), { recursive: true });
  fs.writeFileSync(path.join(root, "run-a", "payload.json"), "{}");
  fs.writeFileSync(path.join(root, "run-a", "owner-home.html"), "<html/>");
  fs.writeFileSync(path.join(root, "run-a", "pages", "tabelog_access_ranking-2026-09.html"), "<html/>");
  fs.mkdirSync(path.join(root, "run-deliver"));
  fs.writeFileSync(path.join(root, "run-deliver", "weekly-card-2026-10-05.json"), "{}");
  fs.writeFileSync(path.join(root, "run-deliver", "tabelog-input.json"), "{}");
  const found = discoverRunFiles(root);
  assert.deepEqual(found.payloads.map((f) => path.basename(path.dirname(f))), ["run-a"]);
  assert.equal(found.ownerHomes.length, 1);
  assert.equal(found.rankings[0].month, "2026-09");
  assert.equal(found.skipped[0].reason, "配信の出力フォルダ");
});

test("assemble from /workspace real runs: no problems, known Ikyu gaps only", () => {
  if (!fs.existsSync("/workspace/run-20261005-tabelog/payload.json")) return; // CI には取得フォルダが無い
  const found = discoverRunFiles("/workspace");
  const t = assembleTabelogSources({ storeKey: "13245351", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05", payloadFiles: found.payloads, ownerHomeFiles: found.ownerHomes, rankingFiles: found.rankings });
  assert.deepEqual(t.problems, []);
  assert.deepEqual(t.gaps, []);
  assert.equal(t.input.notices.new, 2);
  assert.equal(t.input.accessRanking.self.rank, 128);
  assert.ok(t.input.competitors.some((c) => c.own));
  const i = assembleIkyuSources({ storeKey: "112789", storeName: "BISTRO CAVA CAVA", asOf: "2026-10-05", payloadFiles: found.payloads });
  assert.deepEqual(i.problems, []);
  assert.deepEqual(i.gaps, []);
  assert.equal(i.input.monthly.cur.pv, 719);
  assert.ok(i.knownGaps.some((g) => /競合/.test(g)));
});

test("weekly-assemble CLI writes assembled stamp; weekly-deliver --send refuses stubs", async () => {
  if (!fs.existsSync("/workspace/run-20261005-tabelog/payload.json")) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-assemble-cli-"));
  const report = runWeeklyAssemble(["--runs-dir", "/workspace", "--tabelog-store", "13245351", "--ikyu-store", "112789", "--name", "BISTRO CAVA CAVA", "--as-of", "2026-10-05", "--out-dir", dir], { log: () => {} });
  assert.equal(report.exitCode, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "tabelog-input.json"), "utf8"));
  assert.equal(raw.assembled.by, "weekly-assemble");
  assert.deepEqual(sendBlockers(raw, { asOf: "2026-10-05" }), []);
  assert.match(sendBlockers({ storeKey: "1", asOf: "2026-10-05" }, { asOf: "2026-10-05" })[0], /weekly-assemble/);

  const stub = path.join(dir, "stub.json");
  fs.writeFileSync(stub, JSON.stringify({ storeKey: "13245351", storeName: "x", asOf: "2026-10-05", monthlyRows: [{ month: "2026-09", pv: 1 }], dailyRows: [] }));
  await assert.rejects(runWeeklyDeliver(["--tabelog-input", stub, "--name", "x", "--store-id", "89831708-aeac-4d1d-a345-8b345579a27f", "--publish-dir", path.join(dir, "pub"), "--no-post"], { log: () => {} }), /実データの週報入力ではありません/);
  // --allow-unassembled があれば手元確認は通る
  await runWeeklyDeliver(["--tabelog-input", stub, "--name", "x", "--store-id", "89831708-aeac-4d1d-a345-8b345579a27f", "--publish-dir", path.join(dir, "pub"), "--no-post", "--allow-unassembled"], { log: () => {} });
  assert.ok(fs.existsSync(path.join(dir, "pub", "weekly", "89831708-aeac-4d1d-a345-8b345579a27f", "2026-10-05", "index.html")));
});
