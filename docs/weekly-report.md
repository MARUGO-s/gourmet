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

## M-talk の店舗ルームへ届ける（ホストした HTML＋要約カード）

週報は Grok Bot の月曜の作業で、店舗の **M-talk 店舗Bot** として、その Bot の店舗ルーム（例: BistroCAVACAVA＝ルーム 30）へ届けます。
**本体は承認済みの共通テンプレート HTML** です。M-talk `/store-post` は HTML を添付できないため、同じビューの HTML を **GitHub Pages（`marugo-s.github.io`＝許可ホスト）** に載せ、カードの主ボタン **「週報を開く」** でその URL を開きます。PDF は任意（`--pdf`）です。

公開 URL: `https://marugo-s.github.io/gourmet/weekly/<店舗UUID>/<asOf>/`（`public/weekly/.../index.html` ハブ＋`tabelog.html` / `ikyu.html`）。main へのマージで Pages が配置します。

```sh
# 手元で HTML・カードを作り、Pages 用に public/ へ書く（agent-api も呼ばない）。入力は weekly-assemble.mjs の出力だけ
node scripts/weekly-deliver.mjs \
  --tabelog-input <assemble>/tabelog-input.json \
  --ikyu-input <assemble>/ikyu-input.json \
  --name "BISTRO CAVA CAVA" --store-id <店舗UUID> [--as-of 2026-10-05] \
  --out-dir run-xxx/weekly --publish-dir public --no-post

# 確認だけ（既定。M-talk でも投稿しない。送り先の Bot・ルーム・カードの文が返る）
INGEST_TOKEN=... node scripts/weekly-deliver.mjs …同じ引数…   # dryRun

# 実際に投稿する（Pages に HTML が載ったあと。確認の結果が正しいときだけ）
INGEST_TOKEN=... node scripts/weekly-deliver.mjs …同じ引数… --room 30 --send

# PDF も任意で添えるとき
INGEST_TOKEN=... node scripts/weekly-deliver.mjs …同じ引数… --pdf --send
```

- 作るもの: サイト別の週報 HTML＋ハブ（Pages / 手元確認）、カードの要約（サイトごとに KPI 4つ＋直近7日のPV、今週のポイント2つ）。`--pdf` または `--out-dir` のとき PDF も生成（M-talk へ載せるのは `--pdf` のときだけ）。
- 送り先: `agent-api POST /weekly/deliver`（`X-Ingest-Token`）→ gourmet が店舗Bot・ルームを決めて line_report の `mtalk-external-post POST /store-post` へ署名つきで送る。カードの links は `{ label: "週報を開く", url: https://marugo-s.github.io/gourmet/weekly/<店舗UUID>/<asOf>/ }`。`GOURMET_MTALK_TOKEN` は gourmet の Edge Function だけが持ち、Grok Bot には渡しません。
- 店舗: `--store-id`（gourmet の店舗 UUID）、無ければ最初のサイトの店舗キーからアプリの店舗を探します。**Pages 公開（`--publish-dir`）には `--store-id` が必須**です。
- 店舗Bot・ルーム: 店舗Bot は口コミ通知と同じ設定。ルームは「`--room <ID>` → 画面「週報の配信」で選んだルーム → 口コミ通知で選んだルーム → Bot の店舗ルーム（`is_store_room`）→ Bot が参加している全グループ」（BistroCAVACAVA は 30）。
- 二重送信の防止: 店舗×週（作成日の週の月曜、日本時間）で同じ `dedupe_key`（`gourmet-weekly:<店舗 UUID>:<月曜>`）。月曜の作業をやり直しても、同じ週はルームごとにカードが 1 回だけ届きます。
- カードに載せるのは件数・評価・PV などの集計だけ。メールアドレス・電話番号らしき文字列があれば gourmet と M-talk の両方で送りません。

`agent-api POST /weekly/deliver` の本文:

```json
{
  "site": { "source": "tabelog", "storeKey": "13245351" },
  "asOf": "2026-10-05",
  "sections": [
    { "source": "tabelog", "fields": [{ "label": "9月のPV", "value": "4,753 PV（↑ 前月比 2.8%増）" }, { "label": "直近7日のPV", "value": "910 PV（09/28–10/04、前7日比 +1.2%）" }], "items": ["9月のPVは4,753（前月比 +2.8%）。"] },
    { "source": "ikyu", "fields": [{ "label": "9月の予約受付", "value": "8 件" }, { "label": "直近7日のPV", "value": "118 PV（09/27–10/03、前7日比 −68.8%）" }] }
  ],
  "pdf": { "base64": "JVBERi0…", "filename": "BISTRO CAVA CAVA weekly 2026-10-05.pdf" },
  "dryRun": true
}
```

`pdf` は任意。カードの「週報を開く」URL は gourmet が `store.id` と `asOf` から組み立てます（`weeklyHtmlUrl`）。

応答: `{ ok, store: { id, name }, asOf, week, dedupeKey, dryRun, bot: { id, name, how }, roomIds, rooms: [...], html: { url }, pdf: { filename } | null, preview? | deduplicated? }`。送らなかったときは `{ ok: false, skipped: "理由" }`。
エラー: 422（入力・個人情報・HTML の添付）、404（店舗・店舗Bot・ルームが無い）、409（同じ PDF を処理中）、413（PDF 5MB 超）、502（M-talk に届かない。同じ週ならやり直しても二重に届かない）、503（M-talk 連携が未設定）。

## 実データからの組み立て（stub 禁止）と、予定時刻の配信

2026-10-05 の事故: Pages に載せた週報が、手書きの薄い入力（`tabelog-input.json` に月次3項目だけ・日別は 100,110,120… の合成値、一休は runId `t`・架空クチコミ）から作られ、大半が「未取得」になった。実データ（`run-20261005-tabelog/payload.json` ほか）は既にあった。
再発防止として、**週報の入力は必ず `scripts/weekly-assemble.mjs` で最新の取得フォルダから組み立てる**。`weekly-deliver.mjs` は `--publish-dir`（Pages 公開）と `--send` のとき、assemble の印（`assembled`）が無い・必須データが欠けている入力を拒否します（`--allow-unassembled` はテスト・手元確認専用）。

```sh
# 1) 組み立て（ネットワークなし）。runs-dir 直下の取得フォルダの payload*.json・owner-home*.html・pages/tabelog_access_ranking-YYYY-MM.html を読む
node scripts/weekly-assemble.mjs --runs-dir /workspace \
  --tabelog-store 13245351 --ikyu-store 112789 --name "BISTRO CAVA CAVA" --as-of 2026-10-05 \
  --out-dir /workspace/run-20261005-weekly-cava
#   終了コード 0 = 送ってよい / 1 = 必須の実データ欠け・stub（送らない。当日の取得が終わるのを待つ）/ 3 = 取れるはずの項目が欠け（取り直す。だめなら --allow-gaps で「未取得」のまま）
#   assemble-report.json に元ファイル・取得日時・足りない項目・拒否したファイル（stub など）が残る

# 2) HTML を作って Pages 用に public/ へ（agent-api は呼ばない）
node scripts/weekly-deliver.mjs --tabelog-input /workspace/run-20261005-weekly-cava/tabelog-input.json \
  --ikyu-input /workspace/run-20261005-weekly-cava/ikyu-input.json --name "BISTRO CAVA CAVA" \
  --store-id 89831708-aeac-4d1d-a345-8b345579a27f --as-of 2026-10-05 \
  --out-dir /workspace/run-20261005-weekly-cava/weekly --publish-dir public --no-post
```

| 組み立ての元 | 使う項目 |
|---|---|
| 食べログ 取り込み JSON（`run-*-tabelog/payload*.json`。複数を capturedAt 順に重ねる） | 月別（PV・端末・ネット予約・通話）、日別 PV・端末内訳、口コミ（投稿日・評価だけ）、レポート `public_profile`・`reservation_notices`・`public_competitors`・`public_genre_ranking`・`public_new_opens`・`area_ranking` |
| 食べログ 管理トップの保存 HTML（`owner-home*.html`、2日以内） | 新着ご予約情報の件数（新規・変更・キャンセル） |
| 食べログ アクセス数ランキングの保存 HTML（`pages/tabelog_access_ranking-<確定月>.html`） | 確定月の自店順位・PV・前月比 |
| 一休 取り込み JSON（当日・バックフィル・公開ページ・クチコミ。capturedAt 順） | 月別・日別（PV・ページ種別・端末・予約・金額）、公開評価、管理画面クチコミ |

受け付けない入力: `schemaVersion`/`agent`/`runId`（`tabelog-…`・`ikyu-…`）が取り込み JSON の形でないもの、日別 PV が周期的・等差の合成値、配信の出力フォルダ（`weekly-card-*.json` がある）の中身。
作成日（日本時間）より後の取得（遅れた取得。例: 10/6 の取得が止まり 10/7 に取得）: stub・合成値の確認は同じく行ったうえで、**作成日より前の日付がついた行だけ**使う（食べログ: 日別 PV・端末内訳〔date < 作成日〕と作成日の月より前の月別／一休: 作成日より前の日別、作成日の月より前の月の合計行）。取得時点の値（公開ページ・`summary`・予約通知・競合・ジャンル順位・ニューオープン・エリアランキング・口コミ／一休の公開評価・管理画面クチコミ）は使わない。`assembled.sources` に `late: true`・`scope`・`filledDates`（遅れた取得で初めて埋まった日）を残し、`assembled.notes`・assemble-report の `notes` に「◯日は◯日の取得から補った」と書く。確定月のアクセス数ランキング HTML は作成日より後に保存したものも使う（`savedOn`・`late` を残す）。
必須（欠けたら送らない）: 確定月と前月の月別、直近14日の日別 PV（食べログ）／作成日の3日前以降まである日別（一休）。
取れるはずの項目（欠けたら終了コード 3）: 食べログの公開ページ・新着ご予約・アクセス数ランキング・競合・ジャンル順位・ニューオープン・口コミ、一休の公開評価・管理画面クチコミ。公開ページ・一覧は 8 日以内、新着ご予約は 2 日以内の取得だけ使う。

### 実取得があっても「未取得」になる項目（2026-10 時点・作らない）

- 一休: 競合比較（評価上位店・競合表・プラン価格）、エリア内順位、直近30日の新規オープン（一休の公開一覧の取得が未対応）。
- 一休: 直近7日の新着クチコミは管理画面クチコミの投稿日で数える（取得が無い週は「未取得」）。
- 食べログ: 日別の「端末内訳」以外の内訳（ページ種別の日別）は管理画面に無い。予約通知は確認時点の件数で、期間合計ではない。
- 食べログのジャンル順位は、主エリア（曙橋・四ツ谷三丁目）の評価順一覧の上位20件に自店が無いと「掲載なし」。

### 配信の予定（画面「自動取得の設定」→「週報の配信」、migration 023）

- 店舗ごとに **曜日・時刻（日本時間）・送り先ルーム・PDF の有無・有効** を保存します（表 `weekly_delivery_schedules`、保存は `review-api POST /weekly-schedules`）。この曜日・時刻が配信のタイミングを決めます（ルーチンの固定時刻ではない）。
- 送り先ルームの優先順: `--room` → 画面の「週報の配信」で選んだルーム → 「口コミ通知」で選んだルーム → 店舗Botの店舗ルーム。BISTRO CAVACAVA は **ルーム 30**（`supabase/seed/023_weekly_delivery_cava.sql` か画面で保存）。
- Grok Bot は稼働時間（日本時間 9:00〜22:59）の確認のたびに `node scripts/agent-queue.mjs --weekly-due` を呼び、予定を過ぎた店舗があれば次の手順で配信します:
  1. `--weekly-claim --schedule-id <id>`（作業中の印 claimId、期限2時間。asOf = その週の予定日の日本時間）。
  2. `weekly-assemble.mjs`（due の `sites.tabelog` / `sites.ikyu` の店舗コード）。終了コード 1 なら当日の取得（`agent-queue --claim` の依頼）が終わっていない → `--weekly-finish --outcome deferred --reason …`（30分後にもう一度、最大12回）。3 なら足りない公開ページ等を取り直し、だめなら `--allow-gaps` で続けて、足りない項目を報告に書く。
  3. `weekly-deliver.mjs … --publish-dir public --no-post` → `public/weekly/<店舗UUID>/<asOf>/` だけを含むブランチ `weekly/<asOf>-<店舗>` を作り PR → CI 成功後に main へマージ → Pages の URL が 200 を返すまで待つ（HTML だけの PR。コード変更を混ぜない）。
  4. 確認: `INGEST_TOKEN=… weekly-deliver.mjs …同じ引数… --store-id <UUID>`（dryRun。Bot・ルーム・カードの文を確認。`alreadySent` なら送信済み）。
  5. 送信: 同じ引数に `--send`（ルームは画面の設定。CAVA は 30。明示するなら `--room 30`）。応答の `rooms[].cardMessageId` と `html.url` を控える。
  6. `--weekly-finish --schedule-id <id> --claim-id <claimId> --outcome delivered --html-url <URL> --card-ids <cardMessageId>`。送らない判断（店舗Bot なし等）は `skipped`、失敗は `failed --reason …`（30分後にもう一度）。
- 二重送信は店舗×週の `dedupe_key` で M-talk 側でも防ぎます（同じ週をやり直しても1回だけ）。

## 新しいサイトを足すとき

1. `scripts/<site>/weekly-report.js` に `build<Site>WeeklyView(input)` を作り、`renderWeeklyReportHtml` のビュー（JSDoc 参照）を詰める。`site: { key, label }`、KPI 4枚、月次の指標 2〜3 個、表、脚注、次の3アクション。
2. 取れない節は消さずに `未取得` で埋める（見た目の骨格は全サイト同じ）。
3. `scripts/weekly-report.mjs` の `SITES` に登録し、必要ならラッパー `scripts/<site>-weekly-report.mjs` を置く。
4. テストで骨格の同一性（`server/tests/weekly-report-shared.test.js` の chrome 比較）と未取得・PII を確認する。

テスト: `server/tests/weekly-assemble.test.js`（実データの組み立て・stub の拒否）、`server/tests/weekly-schedules.test.js`（配信予定・due/claim/finish・ルームの優先順）、`server/tests/weekly-delivery.test.js`（M-talk への配信・PDF・カード・CLI）、`server/tests/weekly-report-shared.test.js`（共通テンプレート・食べログの薄いラッパー・骨格の同一性・CLI）、`server/tests/ikyu-weekly-report.test.js`（一休の組み立て・未取得・PII・CLI）、`server/tests/tabelog-weekly-parity.test.js`（食べログの内容）。
