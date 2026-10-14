// 週報の入力を実取得データから組み立てる（scripts/shared/weekly-sources.js・weekly-assemble.mjs）。
// stub（手書きの薄い入力）を検出して --send / Pages 公開を止める。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleIkyuSources, assembleTabelogSources, assembledStamp, datedRowsBefore, discoverRunFiles, loadPayloads, looksSynthetic, payloadProblem, sendBlockers } from "../../scripts/shared/weekly-sources.js";
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

// ---------- 作成日より後の取得（遅れた取得）: 日付つきの行だけ使う ----------
const days = (from, to) => { const out = []; for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d); return out; };
const pvOf = (i) => 90 + ((i * 37) % 53) + (i % 3) * 11; // 周期・等差でない実データ風の値
const tabelogPayload = ({ capturedAt, runId, to, octPv = 900, extra = {} }) => ({
  schemaVersion: 1, source: "tabelog", runId, agent: "grok-bot", capturedAt,
  stores: [{
    storeKey: "13245351", name: "BISTRO CAVA CAVA",
    daily: days("2026-09-10", to).map((date, i) => ({ date, pv: pvOf(i), pvPc: 10, pvSp: 10, pvApp: pvOf(i) - 20 })),
    monthly: [{ month: "2026-08", pv: 4624 }, { month: "2026-09", pv: 4753 }, { month: "2026-10", pv: octPv }],
    ...extra,
  }],
});
const writeRun = (root, dir, payload) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); const f = path.join(root, dir, "payload.json"); fs.writeFileSync(f, JSON.stringify(payload)); return f; };

test("遅れた取得: 作成日より前の日別 PV だけ補い、取得時点の値（公開ページ・通知・口コミ・レポート）は使わない", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-late-"));
  const onTime = writeRun(root, "run-20261005-tabelog", tabelogPayload({
    capturedAt: "2026-10-05T01:50:00.000Z", runId: "tabelog-13245351-20261005015000", to: "2026-10-05",
    extra: { reports: [{ kind: "reservation_notices", period: "2026-10-05", data: { new: 1, changed: 0, cancelled: 0, capturedAt: "2026-10-05T01:50:00.000Z" } }] },
  }));
  const late = writeRun(root, "run-20261007-tabelog", tabelogPayload({
    capturedAt: "2026-10-07T04:29:47.000Z", runId: "tabelog-13245351-20261007042947", to: "2026-10-07", octPv: 1500,
    extra: {
      summary: { saveCount: 9999, rating: 4.9 },
      reviews: { items: [{ postedAt: "2026-10-06", rating: 5 }] },
      reports: [
        { kind: "reservation_notices", period: "2026-10-07", data: { new: 7, changed: 7, cancelled: 7, capturedAt: "2026-10-07T04:00:00.000Z" } },
        { kind: "public_profile", period: "2026-10-07", data: { rating: 4.9, saveCount: 9999 } },
        { kind: "area_ranking", period: "2026-10-01", data: { area: "x", self: { rank: 1, pv: 1 } } },
      ],
    },
  }));
  const asOf = "2026-10-06";

  // 遅れた取得が無いと 10/05 が欠ける（従来どおり送らない）
  const before = assembleTabelogSources({ storeKey: "13245351", asOf, payloadFiles: [onTime] });
  assert.ok(before.problems.some((p) => /日別 PV が欠けています（2026-10-05）/.test(p)), before.problems.join("\n"));

  const t = assembleTabelogSources({ storeKey: "13245351", asOf, payloadFiles: [onTime, late] });
  assert.ok(!t.problems.some((p) => /日別 PV/.test(p)), t.problems.join("\n"));
  const dates = t.input.dailyRows.map((d) => d.date);
  assert.ok(dates.includes("2026-10-05"));
  assert.ok(!dates.includes("2026-10-06") && !dates.includes("2026-10-07"), "作成日以降の日は使わない");
  assert.equal(t.input.monthlyRows.find((m) => m.month === "2026-10").pv, 900, "作成日の月（集計中）は遅れた取得で上書きしない");
  assert.equal(t.input.monthlyRows.find((m) => m.month === "2026-09").pv, 4753);
  // 取得時点の値は遅れた取得から使わない
  assert.equal(t.input.notices.new, 1);
  assert.equal(t.input.publicProfile, null);
  assert.equal(t.input.reviews, null);
  assert.equal(t.input.accessRanking, null);
  assert.deepEqual(t.rejected, []);
  const src = t.sources.find((s) => s.file === late);
  assert.equal(src.late, true);
  assert.match(src.scope, /作成日より前の日付の行だけ/);
  assert.deepEqual(src.reports, []);
  assert.deepEqual(src.filledDates, ["2026-10-05"]);
  assert.ok(!t.sources.some((s) => s.file === late && s.kind !== "payload"), "遅れた取得はスナップショットの出どころにならない");
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0], /2026-10-05 は作成日より後の取得（2026-10-07/);
  const stamp = assembledStamp({ site: "tabelog", asOf, result: t });
  assert.deepEqual(stamp.notes, t.notes);
});

test("遅れた取得でも stub・合成値は拒否する（日別を補わない）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-late-stub-"));
  const onTime = writeRun(root, "run-20261005-tabelog", tabelogPayload({ capturedAt: "2026-10-05T01:50:00.000Z", runId: "tabelog-13245351-20261005015000", to: "2026-10-05" }));
  const stubRunId = writeRun(root, "run-late-stub", tabelogPayload({ capturedAt: "2026-10-07T04:29:47.000Z", runId: "t", to: "2026-10-07" }));
  const synthetic = tabelogPayload({ capturedAt: "2026-10-07T04:29:47.000Z", runId: "tabelog-13245351-20261007042947", to: "2026-10-07" });
  synthetic.stores[0].daily = synthetic.stores[0].daily.map((d, i) => ({ ...d, pv: 100 + (i % 7) * 10 }));
  const stubSynthetic = writeRun(root, "run-late-synthetic", synthetic);
  const t = assembleTabelogSources({ storeKey: "13245351", asOf: "2026-10-06", payloadFiles: [onTime, stubRunId, stubSynthetic] });
  assert.ok(t.problems.some((p) => /日別 PV が欠けています（2026-10-05）/.test(p)));
  assert.deepEqual(t.rejected.map((r) => path.basename(path.dirname(r.file))).sort(), ["run-late-stub", "run-late-synthetic"]);
  assert.match(t.rejected.find((r) => r.file === stubRunId).reason, /runId/);
  assert.match(t.rejected.find((r) => r.file === stubSynthetic).reason, /合成/);
  assert.deepEqual(t.notes, []);
});

test("datedRowsBefore / loadPayloads: 一休の遅れた取得は作成日より前の日だけ（公開ページ・クチコミ・作成日の月の合計行を落とす）", () => {
  const store = {
    storeId: "112789", name: "x",
    public: { rating: 4.5, reviewCount: 10 }, reviews: { items: [{ reservationNo: "1", rating: 5 }] },
    pageviews: { months: [
      { month: "2026-09", totals: { pv: 719 }, days: [{ date: "2026-09-30", pv: 24 }] },
      { month: "2026-10", totals: { pv: 999 }, days: [{ date: "2026-10-05", pv: 79 }, { date: "2026-10-06", pv: 23 }] },
      { month: "2026-11", days: [{ date: "2026-11-01", pv: 1 }] },
    ] },
  };
  const d = datedRowsBefore(store, { source: "ikyu", asOf: "2026-10-06" });
  assert.equal(d.public, undefined);
  assert.equal(d.reviews, undefined);
  assert.deepEqual(d.pageviews.months.map((m) => m.month), ["2026-09", "2026-10"]);
  assert.deepEqual(d.pageviews.months[0].totals, { pv: 719 });
  assert.equal(d.pageviews.months[1].totals, undefined);
  assert.deepEqual(d.pageviews.months[1].days.map((x) => x.date), ["2026-10-05"]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-late-ikyu-"));
  const f = path.join(root, "payload.json");
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 1, source: "ikyu", runId: "ikyu-20261007051146", agent: "grok-bot", capturedAt: "2026-10-07T05:11:46.801Z", stores: [store] }));
  const { accepted, rejected } = loadPayloads([f], { source: "ikyu", storeKey: "112789", asOf: "2026-10-06" });
  assert.deepEqual(rejected, []);
  assert.equal(accepted[0].late, true);
  assert.equal(accepted[0].payload.stores[0].public, undefined);
  assert.equal(accepted[0].payload.stores[0].reviews, undefined);
  // 作成日当日以前の取得はそのまま（late なし）
  const { accepted: same } = loadPayloads([f], { source: "ikyu", storeKey: "112789", asOf: "2026-10-07" });
  assert.equal(same[0].late, undefined);
  assert.equal(same[0].store.public.rating, 4.5);
});
