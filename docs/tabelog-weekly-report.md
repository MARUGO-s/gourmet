# 食べログ週報（既定テンプレート）

週報 HTML の見た目は **全サイト共通テンプレート** `scripts/shared/weekly-report.js`（サンプル週報 UI。一休など他サイトも同じ）です。共通部分・内容ルール・新サイトの足し方は [weekly-report.md](weekly-report.md)。このページは食べログ固有の部分です。

食べログ用の入口は `scripts/tabelog/weekly-report.js` の `buildWeeklyReportHtml` / `assembleWeeklyReportInput`（中で `buildTabelogWeeklyView` → 共通テンプレートの `renderWeeklyReportHtml`）。エージェント・ローカルのエクスポートはいずれもこの生成器を使います（別レイアウトの週報 HTML は作らない）。

| 層 | 参照 |
|---|---|
| **UI** | 共通テンプレート（hero / FOCUS / KPI カード / panels / chart-area / 日別バー / 評価・口コミ / competitor bars / action-grid / footnote）。スタイルは共通の `scripts/shared/weekly-report.css.txt`（オフライン・外部 CDN なし） |
| **内容ルール** | 青写真（セクション・未取得の扱い・事実と推測の分離・PII 禁止）。未取得は空欄や `0` にせず **「未取得」**。通話成立≠予約確定、予約通知件数≠期間合計、公開ページに口コミ投稿日なし、を脚注に明記 |

## 生成（エクスポート入口）

```sh
# 入力 JSON → 週報 HTML（既定テンプレート）
node scripts/tabelog-weekly-report.mjs --input weekly-input.json --out weekly-report.html
# 共通 CLI でも同じ
node scripts/weekly-report.mjs --site tabelog --input weekly-input.json --out weekly-report.html

# 標準出力へ
node scripts/tabelog-weekly-report.mjs --input weekly-input.json
```

`--input` は `assembleWeeklyReportInput` に渡すオブジェクト（`storeKey` / `storeName` / `asOf` 必須。月次・日別・公開プロフィール・予約通知・競合などは任意。足りない節は「未取得」）。`focusText` / `heroPoints` は `**太字**` だけ使えます（それ以外はエスケープ）。

ライブラリとして使う場合:

```js
import { assembleWeeklyReportInput, buildWeeklyReportHtml } from "./scripts/tabelog/weekly-report.js";
const input = assembleWeeklyReportInput({ storeKey, storeName, asOf, monthlyRows, dailyRows, /* … */ });
const html = buildWeeklyReportHtml(input);
```

関連: 公開エリア×ジャンルの取得計画は `scripts/tabelog/store-config.js`（`docs/tabelog-page-snapshots.md`）。期間ヘルパーは `scripts/shared/weekly-windows.js`（`scripts/tabelog/weekly-windows.js` は互換の再エクスポート）。AI の週報向け関数は `get_weekly_pv_windows` / `get_public_profile` / `get_reservation_notices` / `get_competitor_snapshot` / `get_genre_rank` / `get_area_new_opens`（`_shared/ai-analyst.js`）。
