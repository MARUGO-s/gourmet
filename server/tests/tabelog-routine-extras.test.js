import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tabelogRoutineExtras } from "../../scripts/tabelog/routine-extras.js";

test("食べログの取得一覧に公開ページとよく見られるページの手順が入る", () => {
  const extras = tabelogRoutineExtras("13245351");
  assert.deepEqual(extras.map((p) => p.page), ["tabelog_public_store", "tabelog_top_pages"]);
  assert.equal(extras[0].url, "https://tabelog.com/tokyo/A1309/A130903/13245351/");
  const out = execFileSync("node", ["scripts/page-snapshots.mjs", "list", "--source", "tabelog", "--store", "13245351"], { encoding: "utf8" });
  const rows = out.trim().split("\n").map((l) => l.split("\t"));
  assert.deepEqual(rows.slice(-2).map((r) => r[0]), ["公開", "ブラウザ"]);
  assert.ok(rows.slice(0, -2).every((r) => r[4].startsWith("https://owner.tabelog.com/")));
  const ikyu = execFileSync("node", ["scripts/page-snapshots.mjs", "list", "--source", "ikyu", "--store", "112789"], { encoding: "utf8" });
  assert.ok(!ikyu.includes("tabelog_public_store"));
});
