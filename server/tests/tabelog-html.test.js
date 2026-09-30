// 保存HTML（合成フィクスチャ）→ 取り込み形式。Playwright Chromium が無い環境（CIなど）ではスキップする。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { readSavedTabelog } from "../../scripts/tabelog/saved-html.js";
import { tabelogResultToPayload } from "../../scripts/tabelog/payload.js";
import { normalizeSourceIngest } from "../../supabase/functions/_shared/source-ingest.js";

const dir = fileURLToPath(new URL("./fixtures/tabelog/", import.meta.url));
const available = (() => { try { return fs.existsSync(chromium.executablePath()); } catch { return false; } })();

test("saved Tabelog owner pages convert offline to a valid ingest payload", { skip: available ? false : "Playwright Chromium is not installed" }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const manifest = JSON.parse(fs.readFileSync(`${dir}manifest.json`, "utf8"));
    const { result, publicUrl } = await readSavedTabelog(manifest, dir, { browser, today: "2026-09-29" });
    assert.equal(publicUrl, "https://tabelog.com/tokyo/A1309/A130903/13245351/");
    assert.equal(result.status, "ok", "中核の数値はそろっている");
    assert.match(result.warning, /よく見られるページ/, "グラフのみの項目は未取得として警告");
    assert.deepEqual(result.data, { rating: 3.26, reviews: 49 });
    assert.equal(result.daily.length, 59, "8月31日 + 9月1〜28日（当日を除く）");
    assert.deepEqual(result.daily.find((d) => d.date === "2026-08-02"), { date: "2026-08-02", pc: 12, sp: 42, app: 5, pv: 60, unclassified: 1 });
    assert.deepEqual(result.monthly.map((m) => [m.month, m.reservations, m.calls, m.mapPrints]), [["2026-07", 12, 4, 3], ["2026-08", 9, null, 2]]);
    assert.deepEqual(result.reviews.map((r) => r.externalId), ["B100:111", "B101:222", "B200:excerpt"], "全文のある口コミの抜粋は重複させない");
    assert.equal(result.reviews[1].date, "2026-08-20");
    assert.equal(result.reports.ranking.self.rank, 2);
    const payload = tabelogResultToPayload(result, { storeKey: manifest.storeKey, name: manifest.name, publicUrl, runId: "fixture", capturedAt: "2026-09-29T09:00:00+09:00", today: "2026-09-29" });
    const checked = normalizeSourceIngest(payload, "2026-09-29");
    assert.equal(checked.stores[0].days.length, 59);
    assert.equal(checked.stores[0].reviews[0].reply_text, "ご来店ありがとうございました。");
    assert.equal(checked.stores[0].rating, 3.26);
    assert.equal(checked.stores[0].public_url, "https://tabelog.com/tokyo/A1309/A130903/13245351/", "口コミ通知のリンク用");
  } finally {
    await browser.close();
  }
});
