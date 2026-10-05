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
    assert.deepEqual(result.reports.deviceSummary, {
      from: "2026-08-01", to: "2026-08-31",
      devices: { pc: { topPage: 321, allPages: 1234 }, sp: { topPage: 210, allPages: 567 }, app: { topPage: 1100, allPages: 2900 } },
      conversion: { from: "2026-08-01", to: "2026-08-31", calls: 4, netReservations: 9, mapPrintsPc: 2 },
    }, "マイレポートの端末別ページサマリー");
    const { capturedAt: noticesAt, ...notices } = result.reports.reservationNotices;
    assert.deepEqual(notices, { new: 2, changed: 2, cancelled: 1 }, "店舗管理トップ（https://owner.tabelog.com/）の新着ご予約情報");
    assert.ok(noticesAt);
    const payload = tabelogResultToPayload(result, { storeKey: manifest.storeKey, name: manifest.name, publicUrl, runId: "fixture", capturedAt: "2026-09-29T09:00:00+09:00", today: "2026-09-29" });
    const checked = normalizeSourceIngest(payload, "2026-09-29");
    assert.equal(checked.stores[0].days.length, 59);
    assert.deepEqual(payload.stores[0].reports.find((r) => r.kind === "device_summary")?.period, "2026-08");
    assert.equal(checked.stores[0].reviews[0].reply_text, "ご来店ありがとうございました。");
    assert.equal(checked.stores[0].rating, 3.26);
    assert.equal(checked.stores[0].public_url, "https://tabelog.com/tokyo/A1309/A130903/13245351/", "口コミ通知のリンク用");
  } finally {
    await browser.close();
  }
});

test("device summary validation rejects malformed values", async () => {
  const { validDeviceSummary } = await import("../../scripts/tabelog/reports.js");
  const ok = { from: "2026-08-01", to: "2026-08-31", devices: { pc: { topPage: 1, allPages: 2 } }, conversion: null };
  assert.deepEqual(validDeviceSummary(ok), ok);
  assert.equal(validDeviceSummary({ ...ok, from: "2026-09-01" }), null, "期間が逆");
  assert.equal(validDeviceSummary({ ...ok, devices: { pc: { topPage: -1, allPages: 2 } } }), null);
  assert.equal(validDeviceSummary({ ...ok, devices: { tv: { topPage: 1, allPages: 2 } } }), null);
  assert.equal(validDeviceSummary(null), null);
});
