# 週報 HTML（全サイト共通テンプレート）

ユーザー承認済みのサンプル週報 UI（PR #38 / #40）を、**すべてのグルメサイトの週報で共通**に使います。食べログ・一休は実装済み。ホットペッパーなど今後のサイトも、同じテンプレートにサイト別のアダプタを足すだけで同じ見た目になります（別レイアウトの週報 HTML は作らない）。

| 層 | ファイル | 役割 |
|---|---|---|
| **共通テンプレート** | `scripts/shared/weekly-report.js`（`renderWeeklyReportHtml`）＋ `scripts/shared/weekly-report.css.txt` | hero / FOCUS / KPI カード ×4 / panels / chart-area（月次の指標切り替え）/ 週次比較 / 30日の日別バー / 評価・口コミ / competitor bars / 汎用パネル（04）/ action-grid ×3 / footnote / footer。オフライン（外部 CDN・通信なし）。サイト名（`site.label`）はタイトル【◯◯週報】・トップライン・`<body data-site>` に入る |
| 期間ヘルパー | `scripts/shared/weekly-windows.js` | 直近7日・前7日・直近30日（作成日の当日は集計中として除外）。`scripts/tabelog/weekly-windows.js` は互換の再エクスポート |
| **食べログ** アダプタ | `scripts/tabelog/weekly-report.js`（`assembleWeeklyReportInput` / `buildTabelogWeeklyView` / `buildWeeklyReportHtml`） | 来店指標（PV・ネット予約・通話成立）、予約通知、公開ページ、競合、エリア順位・ニューオープン。詳細 [tabelog-weekly-report.md](tabelog-weekly-report.md) |
| **一休** アダプタ | `scripts/ikyu/weekly-report.js`（`assembleIkyuWeeklyInput` / `buildIkyuWeeklyView` / `buildIkyuWeeklyReportHtml`） | 日付別アクセス集計（PV・ページ種別・端末・予約件数・予約金額＝受付日ベース）、管理画面クチコミ（件数・要返信）、公開ページの評価・口コミ数 |

## 内容ルール（青写真・全サイト共通）

- 未取得は空欄や `0` にせず **「未取得」**。欠けた日がある週・前月が無い月は比較しない（「前月比」は暦上の前月があるときだけ）。
- 事実と推測を分ける。テンプレートが自動で書く文は取得値と計算値（「計算値」と明記）だけ。推測を書く場合は `（推測）` を付け、アダプタ入力の `heroPoints` などで明示的に渡す。
- 顧客の氏名・連絡先・予約番号・ハンドルネーム・口コミ本文は載せない（件数・評価・日付のみ）。
- 期間の違う数字（月次・週次・日別・確認時点）は同じ集計として扱わない、を脚注に明記。サイト固有の注意（食べログ: 通話成立≠予約確定、予約通知≠期間合計／一休: 予約は受付日ベースで来店日・売上確定額ではない、PV は表示回数）も脚注に入れる。

## 生成（エクスポート入口）

```sh
# 共通 CLI（--site でサイトを選ぶ）
node scripts/weekly-report.mjs --site tabelog --input weekly-input.json --out tabelog-weekly.html
node scripts/weekly-report.mjs --site ikyu --payload payload.json --store 112789 --name "BISTRO CAVA CAVA" --out ikyu-weekly.html

# サイト別の薄いラッパー（中身は同じ CLI）
node scripts/tabelog-weekly-report.mjs --input weekly-input.json --out tabelog-weekly.html
node scripts/ikyu-weekly-report.mjs --payload payload.json [--payload older.json …] --store 112789 \
  --name "BISTRO CAVA CAVA" [--as-of 2026-10-05] --out ikyu-weekly.html
node scripts/ikyu-weekly-report.mjs --input ikyu-weekly-input.json --out ikyu-weekly.html
```

### 一休の入力

- `--payload`: `scripts/ikyu-html-to-json.mjs` の出力（取り込み JSON、schemaVersion 1）。複数指定すると `capturedAt` の古い順に重ね、新しい取得で上書きする（例: 当日の取得＋過去月のバックフィル＋前回の公開ページ）。確定済みの月を後の途中月で上書きしない。
- `--input`: `assembleIkyuWeeklyInput` に渡す JSON。DB の行（`ikyu_monthly_pageviews` / `ikyu_daily_pageviews` の snake_case でも camelCase でも可）を `monthlyRows` / `dailyRows` で、管理画面クチコミを `reviews`、公開ページを `publicProfile` / `publicReviews` で渡せる。`payloads` も可。
- `--as-of` を省くと日本時間の今日。取得日（日本時間）以降の日別は取得時点で集計中なので使わない。
- 一休の管理画面は前日分を空欄で出すことがある（2026-10 の実画面で確認）。最後に PV がある日が作成日の 1〜2 日前なら、その翌日を日別の締め日にして直近7日を比較する（本文に「管理画面に未反映の◯日以降は含めていません」と明記）。それより古い場合は締め日を動かさず「未取得」。
- 日別の予約欄が空欄の日は、管理画面の月合計と同じく予約なしとして7日合計に含める（PV の行が無い日がある期間は「未取得」）。

### 一休で「未取得」になる項目（2026-10 時点）

| 項目 | 理由 |
|---|---|
| 競合比較（評価上位店）・競合表・比較店のプラン価格 | 一休のエリア上位店・プランの取得は未対応（`competitors` を渡せば同じ表に出る） |
| エリア内順位・直近30日の新規オープン | 一休の公開一覧の取得は未対応（`areaRanks` で順位を渡せる） |
| 公開評価・口コミ数 | 公開ページ（`stores[].public`）を含む取り込み JSON が無いとき |
| 管理画面クチコミ・要返信・新着クチコミ | クチコミ（`stores[].reviews`）を含む取り込み JSON が無いとき（公開口コミだけあれば公開ページの投稿日で新着を判定） |
| 前月比 | 暦上の前月の確定データが無いとき |

ライブラリとして使う場合:

```js
import { renderWeeklyReportHtml } from "./scripts/shared/weekly-report.js";            // 共通テンプレート（ビューを描くだけ）
import { assembleIkyuWeeklyInput, buildIkyuWeeklyReportHtml } from "./scripts/ikyu/weekly-report.js";
const html = buildIkyuWeeklyReportHtml(assembleIkyuWeeklyInput({ storeKey: "112789", storeName, asOf, payloads }));
```

## 新しいサイトを足すとき

1. `scripts/<site>/weekly-report.js` に `build<Site>WeeklyView(input)` を作り、`renderWeeklyReportHtml` のビュー（JSDoc 参照）を詰める。`site: { key, label }`、KPI 4枚、月次の指標 2〜3 個、表、脚注、次の3アクション。
2. 取れない節は消さずに `未取得` で埋める（見た目の骨格は全サイト同じ）。
3. `scripts/weekly-report.mjs` の `SITES` に登録し、必要ならラッパー `scripts/<site>-weekly-report.mjs` を置く。
4. テストで骨格の同一性（`server/tests/weekly-report-shared.test.js` の chrome 比較）と未取得・PII を確認する。

テスト: `server/tests/weekly-report-shared.test.js`（共通テンプレート・食べログの薄いラッパー・骨格の同一性・CLI）、`server/tests/ikyu-weekly-report.test.js`（一休の組み立て・未取得・PII・CLI）、`server/tests/tabelog-weekly-parity.test.js`（食べログの内容）。
