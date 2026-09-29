# gourmet — Review Command Center

口コミ・評価・アクセス・予約指標のダッシュボードです。

- 公開先: https://marugo-s.github.io/gourmet/
- Supabase: `gourmet` / `ycsqfajidusuibqljjwr`
- 構成: React/Vite → Supabase Auth + Edge Functions + PostgreSQL。データは外部エージェント（Grok Bot）が `agent-api` で取り込み
- **すべてのサイト（食べログ・ホットペッパー・Google・トレタ・一休・Retty）はGrok Botが取り込みます。** アプリ（ブラウザ・Edge Functions・GitHub Actions）はどのサイトにもログイン・取得しません。画面には「データはGrok Botが取り込み」と最終更新日時を表示します。
- 自動取得の実装があるのは、エージェント側の食べログ・一休の読み取りツール（`scripts/tabelog/`、`scripts/ikyu/`）だけです。他サイトは取り込み形式（下記）で送られたデータを表示します。
- 未ログイン時の数字は読み取り専用のデモです。ログインすると自身の実データだけを表示します。

## 利用手順

1. 右上「ログイン」→「新規登録」でgourmet専用アカウントを作成します。届いた確認メールのリンクを開いてください。
2. ログイン後に表示する店舗を選びます（「全店舗」は全店舗の比較）。店舗と各サイトの店舗IDは「店舗管理」で登録します。
3. 「アカウント管理」で店舗×サイトごとにログイン情報を登録します（食べログは**店舗管理用ID/パスワード**と店舗コード、一休は店舗ID・オペレータID・パスワード）。Grok Botが専用APIで受け取って使います。
4. ダッシュボード上部または「取得依頼」で店舗ごとに「今すぐ取得を依頼」を押します。Grok Botは約5分ごとに依頼を確認します。表示は「依頼中」（確認待ち）→「取得中」（Grok Botが取得開始）→「完了」/「失敗」（理由を表示）。完了するとダッシュボードを読み直します。
5. 同じ店舗・サイト・内容の未完了の依頼は1件だけです。1時間30件・未完了20件まで。24時間拾われない依頼、30分以内に完了報告の無い取得が3回続いた依頼は「失敗」になります。

### 表示するデータ（食べログ）

Grok Botが店舗管理画面から取得し、`scripts/tabelog/`で読み取った内容です。口コミ返信一覧の全文・個別点数・更新日・訪問月・予算・店舗返信と、ピックアップ一覧の抜粋。日別・端末別PVと月別アクセス数・予約組数・通話成立数・地図印刷PV（管理画面で選べる全期間）。エリア順位、全期間のページ別PV。店舗総合点と公開口コミ総数は自店舗の公開ページから取り、個別口コミの平均や管理画面の掲載件数には置き換えません。

- 過去の管理画面には総合PVとPC・スマホ・アプリの合計に差がある期間があります。表示値をそのまま保存し、非負の差を`pvOther`（詳細では`unclassified`）として保存します（端末種別は推測しません）。
- 未取得の数値は`null`で保存し、画面は「未取得」。実測の0PV・0組・0件と区別します。取り込みで`null`を送っても既存値は消えません。
- 比較期間の値がなければ「比較データなし」。未取得や予約専用行を0PVの日として集計しません。
- 以前（アプリ内取得の時代）に保存した`snapshots`・`reviews`・`source_reports`はそのまま表示します。同じ口コミID（例`B123:456`）が取り込まれた場合は取り込み側を表示します。
- 追加認証・CAPTCHA・サイト側のアクセス制限は回避しません（Grok Bot側の運用ルール）。顧客名・電話番号などの予約者情報、決済・求人・設定変更は対象外です。

## 開発

Node.js 22:

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
```

ローカルURL: `http://localhost:5173/gourmet/`。公開設定はコードに含まれ、ローカルも同じgourmet Supabaseにつながります。変更検証中に本番アカウントで取得依頼を登録しないでください。`server/tests/tabelog-html.test.js`はPlaywright Chromium（`npx playwright install chromium`）が無い環境ではスキップします。

## データと秘密情報

テーブル:
- 共通: `credentials`（店舗×サイト、暗号化）, `credential_access_log`, `snapshots`（サイト別の日次KPI）, `sync_log`（取り込み記録）
- 取り込み（全サイト共通）: `source_stores`, `source_daily_metrics`, `source_monthly_metrics`, `source_reviews`, `agent_reports`, `agent_ingest_runs`
- 一休: `ikyu_stores`, `ikyu_daily_pageviews`, `ikyu_monthly_pageviews`, `ikyu_reviews`, `ikyu_ingest_runs`
- 取得依頼: `agent_requests`
- 自動取得の設定: `fetch_schedules`
- 店舗マスタ: `stores`（店舗名・表示順）, `store_sites`（店舗ごとの各サイトの店舗ID）
- 旧データ（読み取りのみ・更新しない）: `reviews`, `source_reports`, `sync_jobs`

RLSで利用者ごとに分離。ブラウザは自身の行のSELECTのみ（`agent_requests`だけは本人の依頼のINSERTも可）。ログインID・パスワードの暗号文・依頼の`claim_id`は読めません。書き込みは認証済みAPIとservice_role専用の関数に限定。評価列は`numeric(4,2)`、すべてのサイトの評価表示を小数点第2位に統一。

- `review-api`: JWTを`auth.getUser()`で検証。公開はデモとサイト一覧のみ。資格情報の登録（暗号化）、ダッシュボード（店舗単位の絞り込み）、取得依頼の登録・一覧（本人のJWTでRLSを適用）、自動取得の設定、店舗マスタ、全店舗の比較。`/sync`は廃止（410）。
- `agent-api`: 外部エージェント専用。`X-Ingest-Token`（`INGEST_TOKEN`）で認証し、`INGEST_USER_ID`の利用者にだけ読み書きする。
- `review-worker`: 廃止。常に410を返し、資格情報を払い出しません。
- Supabaseの秘密設定: `ENCRYPTION_KEY`、`INGEST_TOKEN`、`INGEST_USER_ID`。旧取得用の`GOURMET_WORKER_TOKEN`・`GOURMET_DISPATCH_TOKEN`は不要になりました（本番化の手順で削除・失効）。
- GitHub Actions Secrets: 不要（`GOURMET_WORKER_TOKEN`は削除してください）。DBのservice-roleキーや暗号化キーはGitHubに配置しません。
- クライアント設定のpublishable keyは公開値であり、RLSを必須とします。

## 外部エージェント（Grok Bot）による取り込み

```
アプリ「今すぐ取得を依頼」→ review-api POST /requests → agent_requests（queued）
Grok Bot（約5分ごと）→ agent-api /requests/claim（claimed）→ /credentials/fetch → ログイン済みブラウザで各サイトの管理画面を取得
  → scripts/*-html-to-json.mjs（変換・検証）→ agent-api /ingest（1トランザクションで保存）→ /requests/complete（done）または /requests/fail（failed）
ダッシュボード ← snapshots / source_* / ikyu_*（ブラウザはSELECTのみ）
```

依頼が無くても、Grok Botは定期的に取り込めます（依頼は「今すぐ」の合図です）。

### agent-api（エージェント専用）

- ベースURL: `https://ycsqfajidusuibqljjwr.supabase.co/functions/v1/agent-api`。すべて`POST`・JSON。
- 認証: ヘッダー`X-Ingest-Token: <INGEST_TOKEN>`（32文字以上、定数時間比較）。対象の利用者はSupabase secret `INGEST_USER_ID`で固定され、リクエストで指定できません。CORSは許可しません。本文は8MBまで。検証エラーは422（どの項目かを日本語で返し、何も保存しません）。

| パス | 入力 | 出力 |
|---|---|---|
| `/ingest` | 共通形式（下記）。`source:"ikyu"`は一休形式 | `{"ok":true,"source","status":"ok\|partial","run_id","stores","days","months","reviews","new_reviews","reports","skippedDays"}` |
| `/ikyu/ingest` | 一休形式（`/ingest`と同じ処理） | 同上（`reports`なし） |
| `/credentials/versions` | `{}` | `{"credentials":[{"source","storeKey","label","credentialsVersion","updatedAt"}]}`（秘密情報なし） |
| `/credentials/fetch` | `{"source","storeKey","knownVersion","agent"}` | 版が同じなら`{"unchanged":true,...}`、違えば`{"credentialsVersion","updatedAt","fields":{...}}`。毎回`credential_access_log`に記録 |
| `/requests/pending` | `{"source"?}` | `{"requests":[依頼]}`（依頼中・取得中、古い順100件） |
| `/requests/claim` | `{"agent","source"?,"limit"?:1〜20}` | `{"requests":[{...依頼,"claimId"}]}`。`FOR UPDATE SKIP LOCKED`で原子的に取得中へ |
| `/requests/complete` | `{"id","claimId","result"?:{...}}` | `{"request":{...}}`（同じ報告の再送は成功扱い） |
| `/requests/fail` | `{"id","claimId","error":"理由","result"?}` | 同上。`claimId`不一致・期限切れは409 |
| `/schedules/enqueue-due` | `{"limit"?:1〜50（既定20）,"dryRun"?:false}` | `{"now","dryRun","enqueued":[{"scheduleId","source","storeId","requestId","dueAt","nextDueAt"}],"skipped":[{"scheduleId","source","storeId","reason":"open_request\|rate_limited\|concurrent\|invalid","nextDueAt"?}]}` |

依頼の形: `{"id","source","storeId","action":"sync_now|fetch_metrics|fetch_reviews|backfill","params":{"fromMonth"?,"toMonth"?,"note"?},"status":"queued|claimed|done|failed","requestedAt","claimedAt","finishedAt","claimedBy","attempts","result","error"}`。`backfill`は`fromMonth`〜`toMonth`（最大120か月）の過去分。取得中のまま30分を過ぎると再び`queued`になり（3回で`failed`）、24時間拾われない依頼は`failed`になります。

```sh
INGEST_TOKEN=... node scripts/agent-queue.mjs --list
INGEST_TOKEN=... node scripts/agent-queue.mjs --claim --limit 1 --agent grok-bot          # claimId を控える
INGEST_TOKEN=... node scripts/agent-queue.mjs --complete <id> --claim-id <claimId> --result '{"days":30,"reviews":12}'
INGEST_TOKEN=... node scripts/agent-queue.mjs --fail <id> --claim-id <claimId> --error "追加認証が必要でした"
INGEST_TOKEN=... node scripts/agent-queue.mjs --enqueue-due [--limit 20] [--dry-run]      # 自動取得の設定を依頼に変える（--claim の前）
```

### 自動取得の設定（店舗×サイト、migration 012）

- 画面「自動取得の設定」で、店舗×サイトごとに周期（オフ／○時間ごと／毎日○時／毎週○曜○時、日本時間）を保存します。保存は`review-api` `POST /schedules`（JWT検証後、本人の`user_id`に限定）、表は`fetch_schedules`（ブラウザは本人の行のSELECTのみ）。一休・食べログ以外（ホットペッパー／トレタ／Google）は「準備中」と表示しますが、保存はできます。
- Grok Botは稼働時間（日本時間 9:00〜22:59）の各確認で、`--claim`の前に`--enqueue-due`を呼びます。`next_due_at`を過ぎた有効な設定ごとに`agent_requests`（`action:"sync_now"`、`params:{"trigger":"schedule","scheduleId","dueAt"}`）を登録し、`last_enqueued_at`・`last_request_id`と次の`next_due_at`を保存します。稼働時間外の予定は、次の稼働開始時に1回だけ依頼されます（溜まった回数分は依頼しません）。
- 同じ店舗×サイトの依頼が依頼中・取得中なら新たに依頼せず、次回予定だけ進めます（`open_request`）。依頼の件数制限（1時間30件・未完了20件）に達したら予定を戻して終了し、次の確認で再度依頼します（`rate_limited`）。次回予定は`next_due_at`が変わっていない場合だけ更新するため、複数のエージェントが同時に呼んでも二重に依頼しません（`concurrent`）。
- 次回予定の計算は`supabase/functions/_shared/fetch-schedules.js`（Node/Edge/ブラウザ共通、テストあり）。○時間ごとは前回の予定時刻から数え、毎日・毎週はその時刻より後の最初の日本時間の時刻です。

### AI分析（migration 014）

- 「AI分析」画面で店舗（全店舗／各店舗）と期間を選び、PV・予約・口コミについて日本語で質問できます（会話はブラウザのタブを閉じるまで`sessionStorage`に保存）。「レポート作成」は、サマリー・KPIの推移・サイト別の比較・口コミの傾向・未返信の口コミ・改善提案をまとめて`ai_reports`に保存し、一覧から開き直し・印刷（PDF）・Markdown/HTMLのダウンロード・削除ができます。
- `ai-analyst`（Edge Function）は本人のJWTを検証し、本人のデータだけを本人のJWT（RLS・SELECTのみ）で読みます。OpenAIのChat Completionsに渡すのは集計値と短縮した口コミの抜粋だけで、モデルは決められた集計関数（`list_stores`・`get_kpis`・`get_pv_trend`・`get_monthly_metrics`・`get_review_stats`・`get_reviews`・`compare_stores`、引数は検証）だけを呼べます。SQLや表名はモデルから受け取りません。レポートの数値の表はサーバーの集計で作り、文章だけをAIが書きます。
- APIキー（`OPENAI_API_KEY`）はSupabaseの秘密情報だけにあり、応答・エラー文・ログに出しません。回数制限: 質問60回／時、レポート10件／時（利用者ごと）。
- API（`ai-analyst`、JWT必須）: `GET /status`（`{"configured","model","limits"}`）、`POST /ask`（`{"question","storeId"?,"from"?,"to"?,"history"?}`→`{"answer","model","calls","period","store"}`）、`GET /reports`、`GET /reports/:id`、`POST /reports`（`{"storeId"?,"from"?,"to"?,"title"?,"focus"?}`→201`{"report"}`）、`DELETE /reports/:id`。期間の既定は直近90日（前日まで）、最大2年。

### 店舗の選択と全店舗の比較（migration 013）

- ログイン後、店舗が未選択なら「店舗の選択」画面（上に「全店舗」、下に店舗のカード）を表示します。選択はブラウザの`localStorage`（`gourmet.selectedStore.<ユーザーID>`）に保存し、画面上部の切り替え（「選び直す」で選択画面へ）と左の「表示中の店舗」で確認・変更できます。**表示の絞り込みだけで、店長ごとの権限ではありません**（データは従来どおり利用者ごとにRLSで分離）。
- 店舗を選ぶと、ダッシュボード・口コミ・取得依頼・自動取得の設定・アカウント管理は、その店舗に設定した各サイトの店舗IDのデータだけを表示します。新しいアカウント・依頼・自動取得の設定の「店舗」は店舗マスタの選択肢で、既定は表示中の店舗です。サイトの店舗ID（一休の6桁の店舗ID、食べログの店舗コード など）は店舗の設定を使い、未設定ならその場で入力すると店舗に保存します（別の店舗に設定済みのIDは保存できません）。
- 「全店舗」は「全店舗の比較」を開きます。店舗ごと（「サイト別」ではサイトごと）に、対象月のPV・前月PV・前月比（差と%）・予約・評価・口コミ数・未返信・最終更新を表示し、列見出しで並び替え、最下行に合計を表示します。店舗名を押すとその店舗へ切り替えます。対象月の既定は、当月より前でPVのある最新の月です。
- 「店舗管理」で店舗の追加・名前の変更・並び替え・削除と、店舗ごとの各サイトの店舗IDを設定します。店舗を削除しても、アカウント・依頼・設定・取り込みデータは削除されず「未割り当て」に表示されます。
- 集計規則（`supabase/functions/_shared/stores.js`、Node/Edge/ブラウザ共通・テストあり）:
  - 取り込みデータ（`source_*`・`ikyu_*`）は店舗IDごとの行から集計します。旧データ（アプリ内取得の時代の`snapshots`・`reviews`・`source_reports`、店舗IDなし）は既定の店舗コード`''`のデータとして扱い、`snapshots`はそのサイト×日（予約は月）に店舗IDのある行が無い場合だけ使います（取り込み後の`snapshots`は全店舗合計のため）。
  - 同じ店舗・同じサイトに`''`と他のコード（例: 食べログ`''`と`13245351`）がある場合、`''`は別名として扱い、他のコードに値がある期間は`''`の値を使いません（二重計上しない）。`''`以外の複数コードは合計（評価は平均）します。
  - どの店舗にも設定されていない店舗ID（データ・アカウントのあるもの）は「未割り当て」にまとめて表示し、合計に含めます。
  - 評価は各サイトの店舗の最新値（一休は公開ページの評価）、口コミ数はサイトの掲載数、未返信は要返信の口コミ（`needs_reply`）の件数。取り込みの無いサイトは旧`snapshots`の最新の評価・口コミ数を`''`の値とします。店舗単位のダッシュボードでは、一休の評価は店舗の最新値のみ（前週比なし）です。
- API（`review-api`、JWT必須。閲覧は本人のJWT（RLS）、保存は検証後に本人の`user_id`に限定してservice_role）:

| メソッド・パス | 入力 | 出力 |
|---|---|---|
| `GET /stores` | — | `{"stores":[{"id","name","sortOrder","updatedAt","sites":[{"id","storeId","source","siteStoreKey"}]}]}`（表示順） |
| `POST /stores` | `{"name","sortOrder"?}` | 201 `{"store"}`。同名は409、200店舗まで |
| `POST /stores/:id` | `{"name"?,"sortOrder"?}` | `{"store"}`（404/409） |
| `POST /stores/reorder` | `{"ids":[全店舗のid]}` | `{"stores"}`（表示順を1〜nに） |
| `DELETE /stores/:id` | — | `{"ok":true}`（店舗と割り当てだけ削除） |
| `POST /stores/:id/sites` | `{"source","siteStoreKey"}`（一休は6桁、他は英数字・`_`・`-`の40文字以内、`''`=既定） | 201 `{"site"}`。同じ店舗に設定済みなら200、別の店舗に設定済みなら409 |
| `DELETE /stores/:id/sites/:siteId` | — | `{"ok":true}` |
| `GET /overview?month=YYYY-MM` | 任意の対象月 | `{"overview":{"month","prevMonth","sources":[...],"stores":[{"id","name","sortOrder","sites":{"<source>":{"keys":[{"key","name"}],"pv","prevPv","pvChange","pvChangePct","reservations","prevReservations","rating","reviewCount","unreplied","lastUpdatedAt"}},"totals":{...同じ項目,"ratingSites"}}],"unassigned":{同じ形,"id":"unassigned","name":"未割り当て"}\|null,"totals":{...,"sites":{"<source>":{...}}}}}` |
| `GET /dashboard?source=&store=` | `store`=`all`（既定）/店舗ID/`unassigned` | 従来の形＋`"store"`。店舗IDが無ければ404 |

### 資格情報（店舗×サイト）

- 「アカウント管理」で店舗ごとに登録します。一休は店舗ID（6桁）・オペレータID・パスワード（1店舗=1ログイン、同じ店舗IDは上書き）。他サイトは店舗コード（食べログは店舗ID推奨）ごとに複数登録でき、未入力は既定の1件です。取り込みの`storeKey`・依頼の`storeId`には同じ店舗コードを使います。
- ID・パスワードは`review-api`で`ENCRYPTION_KEY`（Supabase secret）によりAES-256-GCMで暗号化して保存します。ブラウザからはログインID・暗号文とも読めず、「登録済み・版・更新日時」だけを表示します。
- 変更のたびに`credentials_version`が上がります。エージェントは版が変わったときだけ再取得します。
- 復号した資格情報は`agent-api`の`/credentials/fetch`だけが返し、毎回`credential_access_log`（issued / unchanged / not_found / decrypt_failed）に記録します。記録できない場合は払い出しません。

```sh
# 一覧（版・更新日時のみ。秘密情報なし）
INGEST_TOKEN=... node scripts/agent-credentials.mjs --list
# 取得してキャッシュ（~/.review-agent/credentials/112789_ikyu.json、ディレクトリ700・ファイル600）
INGEST_TOKEN=... node scripts/agent-credentials.mjs --source ikyu --store 112789 --print-masked
```

`--dir`または`AGENT_CREDENTIAL_DIR`で保存先を変更できます。平文は標準出力に出さず、`--print-masked`は伏せ字だけです。`--force`は版が同じでも再取得します（記録されます）。キャッシュファイルの形式: `{"source","storeKey","credentialsVersion","updatedAt","fetchedAt","fields":{"storeId","operatorId","password"}}`（一休以外は`{"loginId","password"}`）。

### 共通の取り込みJSON（schemaVersion 1。食べログ・ホットペッパー・Google・トレタ・Retty）

```json
{
  "schemaVersion": 1,
  "source": "tabelog",
  "runId": "tabelog-13245351-20260929090000",
  "agent": "grok-bot",
  "capturedAt": "2026-09-29T09:00:00+09:00",
  "requestId": "3f2b8a4e-1111-4222-8333-944445555666",
  "warning": "（任意）一部だけ取得した場合の説明。指定すると status=partial",
  "stores": [{
    "storeKey": "13245351",
    "name": "テスト食堂",
    "summary": { "rating": 3.26, "reviewCount": 49 },
    "daily": [
      { "date": "2026-09-28", "pv": 60, "pvPc": 12, "pvSp": 42, "pvApp": 5, "pvOther": 1,
        "reservations": null, "reservationAmount": null, "covers": null, "visits": null, "calls": null, "extra": {} }
    ],
    "monthly": [
      { "month": "2026-08", "pv": 1860, "pvPc": 341, "pvSp": 1364, "pvApp": 155, "pvOther": 0,
        "reservations": 9, "calls": 4, "extra": { "mapPrints": 2 } }
    ],
    "reviews": { "total": 1, "items": [{
      "externalId": "B100:111", "rating": 3.47, "scores": [{ "label": "夜", "value": 3.47, "breakdown": "料理・味 3.5 サービス 3.4" }],
      "title": "前菜が…", "text": "前菜がとても美味しかったです。", "textComplete": true, "author": "テスト花子",
      "postedAt": "2026-09-01", "visitDate": null, "visitMonth": "2026-08", "publishedAt": null, "status": null,
      "reply": { "text": "ご来店ありがとうございました。", "date": "2026-09-02", "status": "公開中" },
      "needsReply": null, "details": { "usedPrice": "￥8,000～￥9,999" }
    }]},
    "reports": [{ "kind": "area_ranking", "period": "2026-09-28", "data": { "area": "銀座", "entries": [] } }]
  }]
}
```

他サイトの例（Google、店舗コード省略＝既定の店舗、評価と口コミだけ）:

```json
{ "schemaVersion": 1, "source": "google", "runId": "google-20260929-1", "agent": "grok-bot",
  "stores": [{ "storeKey": "", "summary": { "rating": 4.2, "reviewCount": 311 },
    "reviews": { "total": 1, "items": [{ "externalId": "g-ChdDSUhN", "rating": 5, "text": "また来ます", "author": "A", "postedAt": "2026-09-27", "reply": null }] } }] }
```

- `requestId`（任意）は対応する取得依頼の`id`で、取り込み記録（`agent_ingest_runs`）に残ります。依頼の完了は`/requests/complete`で別途報告します。
- 数値項目（`pv`・`pvSp`・`pvPc`・`pvApp`・`pvOther`・`reservations`・`reservationAmount`（円）・`covers`（人数）・`visits`・`calls`、`extra`の値）は0以上の整数。**未掲載はnull**（0と区別。nullは既存値を消しません）。PVは表示回数でユニーク数ではありません。
- 端末別: `pvOther`（未分類の差）を指定した場合は、未指定の端末を0として`pvSp+pvPc+pvApp+pvOther = pv`。省略した場合は端末別の合計が`pv`を超えないこと。
- `extra`: サイト固有の数値（英字始まりの英数字キー、30個まで。例: 食べログ`mapPrints`）。
- 当日（日本時間）以降の日は集計中のため保存しません（`skippedDays`）。`monthly`は当月以前、前月以前を確定（`complete`）としてサーバーが判定。月別が無い前月以前の月は、全日の日別がそろっていれば日別の合計を月別（`derived`）として保存します（明示の月別値は上書きしません）。
- `summary`は取り込んだ日（日本時間）の店舗の評価（0〜5、小数第2位）・口コミ数として記録します。サイト全体の評価は店舗の最新値の平均、口コミ数は合計です。
- 口コミは サイト×店舗×`externalId`（英数字と`._:#-`、200文字まで）で一意。日付は`YYYY-MM-DD`、訪問月は`YYYY-MM`。`needsReply`を省略すると返信本文または`status`（返信済・対応済・処理済・完了）から判定します（食べログは判定しません）。`details.url`は保存しません。予約者の氏名は送らないでください。
- `reports`: サイト固有の詳細（`kind`×`period`で上書き、1件200KB・20件まで）。食べログは`area_ranking`・`top_pages`・`owner_reviews`・`page_history`を詳細分析に表示します。
- 上限: 50店舗・店舗あたり日別5000日・月別240か月・口コミ2000件。
- 冪等: 同じ`runId`・日・月・口コミIDの再送は上書き。取り込みに含まれない過去の行は削除しません。サイトの全店舗合計を`snapshots`へ反映し、「すべて」のKPI・PV推移に含めます（日別PVは日付の行、月別予約はその月1日の行、評価・口コミ数は取り込んだ日の行）。

### 食べログ: 保存HTMLからの変換（エージェント側）

`scripts/tabelog/`はアプリの実行環境では使いません。`owner.js`・`reports.js`・`public.js`の`read*`関数は`document`を読む自己完結関数で、Grok Botのログイン済みブラウザで`page.evaluate`するか、保存したHTMLを下記で読み取ります（ネットワーク遮断・JavaScript無効のChromium。ログインしません）。

```sh
node scripts/tabelog-html-to-json.mjs --manifest manifest.json --out payload.json [--request-id <依頼id>]
node scripts/agent-ingest.mjs payload.json --dry-run
INGEST_TOKEN=... node scripts/agent-ingest.mjs payload.json
```

manifest（パスはmanifestの場所基準）: `{"storeKey":"13245351","name":"店名","daily":["日別PVの各月のHTML"...],"conversion":"来店指標（全期間を選択）.html","myReport":"マイレポート.html","accessRanking":"アクセスランキング.html","reviews":{"reply":["口コミ返信一覧の各ページ"...],"pickup":["ピックアップの各ページ"...]},"public":"自店舗の公開ページ.html","pageHistory":{"first":"YYYYMM","last":"YYYYMM","pc":"...","sp":"...","app":"..."},"topPages":"top-pages.json（任意）"}`。「よく見られるページ」はグラフ（JavaScript）の値なので、ブラウザで`readTopPages`した結果をJSONで渡します。口コミは全ページが必要です（件数が揃わない場合は停止）。合成フィクスチャ: `server/tests/fixtures/tabelog/`。

### 一休.comレストラン

一休は管理画面の構成（ページ種別×端末のPV、当日予約、予約番号単位の口コミ）が異なるため専用の表（`ikyu_*`）と形式を使います。`/ingest`に`"source":"ikyu"`を付けるか`/ikyu/ingest`へ送ります。
公開ページ（`restaurant.ikyu.com/<店舗ID>`）の総合評価・口コミ数・口コミは`stores[].public`で送ります。PR #11（migration 009、アプリ内の公開ページ同期）で保存済みの値（`snapshots`の`source='ikyu'`の評価・口コミ数、`reviews`の`source='ikyu'`・口コミID`I<店舗ID>:<投稿者ID>`）はそのまま表示され、同じ口コミIDで送ると同じ行が更新されます。

#### 一休の取り込みJSON（schemaVersion 1、`"source":"ikyu"`。`/ikyu/ingest`では省略可）

```json
{
  "schemaVersion": 1,
  "source": "ikyu",
  "runId": "ikyu-20260929T0900-112789",
  "agent": "grok-bot",
  "capturedAt": "2026-09-29T09:00:00+09:00",
  "warning": "（任意）一部だけ取得した場合の説明。指定すると status=partial",
  "stores": [{
    "storeId": "112789",
    "name": "ビストロ サヴァサヴァ",
    "pageviews": { "months": [{
      "month": "2026-09",
      "totals": { "guideSp": 368, "guidePc": 218, "guide": 586, "planSp": 51, "planPc": 28, "plan": 79,
                  "otherSp": 0, "otherPc": 0, "other": 0, "sp": 419, "pc": 246, "pv": 665, "reservations": 6, "amount": 128700 },
      "days": [
        { "date": "2026-09-22", "guideSp": 52, "guidePc": 32, "guide": 84, "planSp": 7, "planPc": 4, "plan": 11,
          "otherSp": 0, "otherPc": 0, "other": 0, "sp": 59, "pc": 36, "pv": 95, "reservations": 2, "amount": 33000 }
      ]
    }]},
    "reviews": { "total": 13, "items": [{
      "reservationNo": "26092000", "visitDate": "2026-09-20", "visitTime": "18:30",
      "postedAt": "2026-09-22", "publishedAt": "2026-09-24", "handleName": "グルメ太郎", "publication": "公開中",
      "rating": 5, "scores": [{ "label": "料理・味", "value": 5 }, { "label": "サービス", "value": 4 }],
      "title": "", "text": "記念日で利用しました。…", "reply": null,
      "processing": "未返信 ／ 未処理", "needsReply": true
    }]},
    "public": { "rating": 4.38, "reviewCount": 128, "reviews": [
      { "externalId": "I112789:305ca13a07989a902773", "author": "ぎん３", "rating": 5, "text": "初めて利用しました。", "date": "2026-08-23" }
    ]}
  }]
}
```

- `guide*`=店舗ガイド、`plan*`=プラン詳細、`other*`=その他。各`Sp`/`Pc`/合計。`sp`/`pc`/`pv`=全ページの合計。`reservations`/`amount`=管理画面の「当日予約」（その日に受け付けた予約の件数・金額、円）。PVは表示回数でユニーク数ではありません。
- 数値は0以上の整数。**未掲載はnull**（0と区別）。スマホ+PC=合計、3ページ種別の合計=`pv`、`sp`+`pc`=`pv`が合わない行は拒否します。`totals`（月の合計行）がある場合、全日が揃っていれば日別の合計と照合します。
- 当日（日本時間）以降の日は集計中のため保存しません（`skippedDays`）。月の確定（`complete`）は、前月以前で全日数が揃った場合にサーバーが判定します（送信側の値は使いません）。
- 口コミは店舗ID+`reservationNo`で一意。日付は`YYYY-MM-DD`、時刻は`HH:MM`、点数は0〜5（小数第2位で保存・表示）。`needsReply`を省略すると、返信本文または処理状況（返信済・対応済・処理済・完了）から判定します。**予約者の氏名は送らないでください**（ハンドルネームのみ）。一休の返信画面へのリンクは店舗IDからサーバー側で作成し、送信値は使いません。
- `public`（任意）: `rating`は0〜5（公開ページの総合評価）、`reviewCount`は公開口コミ数。`reviews[].externalId`は`I<その店舗ID>:<投稿者ID（16進8〜64桁）>`で一意。評価は`ikyu_stores.public_*`へ、口コミは#11と同じ`reviews`表へ保存し、全一休店舗の評価の平均（小数第2位）と口コミ数の合計を日本時間の当日の`snapshots(source='ikyu')`へ反映します（#11と同じ規約）。PV・口コミ・公開評価のいずれかがあれば1回の取り込みとして受け付けます。
- 公開口コミと管理画面の口コミ（予約番号単位）は同じ投稿のことがあるため、本文が同じ公開口コミは一覧で1件として表示します。
- 上限: 50店舗・店舗あたり40か月・口コミ1000件・公開口コミ1000件・本文50000文字。
- 冪等: 同じ店舗・日付／月／予約番号は上書き、同じ`runId`の再送は同じ取り込み記録を更新します。取り込みに含まれない過去の日・月・口コミは削除しません。全一休店舗の合計は`snapshots(source='ikyu')`にも反映し、「すべて」のKPI・PV推移に含めます。

#### 一休: HTMLからの変換

`scripts/ikyu/`（アプリの実行環境では使いません）は保存したHTMLを上記JSONへ変換します。Shift_JIS/UTF-8を自動判定します（HTTPヘッダー → UTF-8の妥当性 → meta → Shift_JIS。ブラウザで保存したHTMLはmetaがShift_JISのまま本文がUTF-8のことがあるため）。

```sh
node scripts/ikyu-html-to-json.mjs --store 112789 \
  --pv 2026-09=pv-2026-09.html --pv 2026-08=pv-2026-08.html \
  --reviews impressions-p1.html --reviews impressions-p2.html \
  --public-store public-top.html --public-reviews public-reviews-1.html --out payload.json
node scripts/agent-ingest.mjs payload.json --dry-run   # 送信せずサーバーと同じ検証（ikyu-ingest.mjs でも可）
INGEST_TOKEN=... node scripts/agent-ingest.mjs payload.json
```

取得元: 一休の店舗管理画面のPV（月別、日別の表）とクチコミ一覧（`https://restaurant.ikyu.com/rsOwner/v2/<店舗ID>/legacy?path=/scriptO/rsOwnImpressions.asp`、10件/ページ）。クチコミは全ページのHTMLを渡してください。件数が揃わない場合は変換を停止します。公開ページ（店舗トップと`/reviews`）の読み取りは`scripts/ikyu/public.js`（#11の読み取り規則を移設。ネットワークには接続しません）。manifestでは店舗ごとに`"public":{"store":"top.html","reviews":["reviews-1.html"]}`。確定済みの月は再取得不要です（当月・前月だけ毎回更新）。

**注意**: パーサーは項目構成をもとに作成した合成HTML（`server/tests/fixtures/ikyu-*`、SYNTHETIC表記）で検証しています。実画面のHTMLで列名・ラベルが異なる場合は推測で埋めずにエラーで停止します。初回は実画面で`--dry-run`し、合計値が管理画面と一致することを確認してください。追加認証・アクセス制限の回避は行いません。

#### 一休の表示内容

店舗選択（全店舗合計／店舗別）、公開ページの評価（店舗別・全店舗平均と取り込み日時）、今月1日〜最新日のPVと前月同期・前年同期比、予約件数・金額、PV→予約転換率、プラン詳細への遷移率、日別PVの積み上げ（端末別／ページ別）と予約件数、曜日別平均（直近13週）、集客ファネル（店舗ガイド→プラン詳細→予約）、月別表（確定月の前月比・前年比）、店舗別比較、項目別平均評価・四半期の評価推移・点数分布、要返信の口コミ（一休の返信画面を新しいタブで開くリンク）。口コミ平均は個別評価の単純平均で、一休の公式な店舗評価ではありません。比較期間に欠けた日がある場合は「比較データなし」とし、未取得を0PVとして扱いません。

## 本番化の手順（利用者の操作が必要）

前提: 本番（`ycsqfajidusuibqljjwr`）には001〜009（`009_ikyu_public_sync.sql`まで）が適用済み、Edge Functionsは`main`（#11）から配置済み。追加するのは`010_ikyu_ingest_and_store_credentials.sql`と`011_external_agent_ingest_and_requests.sql`だけです。

1. 旧アプリ内同期を先に止める: GitHub Actionsで「Collect gourmet metrics」（`sync-worker.yml`）を無効化する（`gh workflow disable sync-worker.yml -R MARUGO-s/gourmet`）。
2. 適用前の確認（対象プロジェクトと未適用分）:
   ```sh
   supabase link --project-ref ycsqfajidusuibqljjwr
   supabase migration list --linked          # 001〜009 が Remote 列にあり、010・011 だけが未適用であること
   supabase db push --linked --dry-run       # 適用予定が 010・011 の2件だけであること
   ```
   履歴表に001〜009が記録されていない（手動適用だった）場合は`db push`を使わず、SQLエディタまたは`psql`で010→011の順に2ファイルだけ実行する。
3. 適用: `supabase db push --linked`（010→011）。010は資格情報を店舗×サイト単位にし（#9の3項目形式の一休アカウントは店舗IDを引き継ぎ、読み取れない旧形式の行は店舗ID未設定のまま残る）、011は処理中の`sync_jobs`を終了扱いにして、009の`enqueue_sync(uuid,text)`を含む旧キュー関数の実行権限を外します（関数・履歴・#11の一休公開データは残ります）。
4. 直後に3関数を配置する（010以降、旧`review-api`のアカウント保存と同期ボタンは失敗するため）:
   ```sh
   supabase functions deploy review-api    --project-ref ycsqfajidusuibqljjwr --no-verify-jwt
   supabase functions deploy review-worker --project-ref ycsqfajidusuibqljjwr --no-verify-jwt   # 410を返す廃止版
   supabase functions deploy agent-api     --project-ref ycsqfajidusuibqljjwr --no-verify-jwt
   ```
5. 秘密情報（値はエージェントのマシンと Supabase だけに置き、ブラウザ・Git・GitHub Secretsには置かない）:
   ```sh
   supabase secrets set --project-ref ycsqfajidusuibqljjwr INGEST_TOKEN=<32文字以上のランダム値> INGEST_USER_ID=<取り込み先のユーザーID>
   supabase secrets unset --project-ref ycsqfajidusuibqljjwr GOURMET_WORKER_TOKEN GOURMET_DISPATCH_TOKEN
   ```
   `ENCRYPTION_KEY`は既存の値のまま（変更すると保存済みパスワードを復号できません）。GitHub Secretsの`GOURMET_WORKER_TOKEN`を削除し、fine-grained PAT（`GOURMET_DISPATCH_TOKEN`）を失効させる。
6. ブランチ`grokbot-agent-ingest`のPRを作成し、テスト成功後にmainへマージする（GitHub Pagesの画面が更新され、`sync-worker.yml`は削除されます）。
7. アプリの「アカウント管理」で店舗×サイトを登録し（食べログは店舗コード付き、店舗ID未設定の一休の行は登録し直す）、Grok Botに`INGEST_TOKEN`・`AGENT_API_URL`と手順（`agent-queue.mjs --claim`→`agent-credentials.mjs`→取得→変換→`agent-ingest.mjs`→`--complete`/`--fail`、約5分間隔）を設定する。
8. 初回は実画面の保存HTMLで`--dry-run`し、合計値が管理画面と一致することを確認してから送信する。任意で`scripts/verify-cloud.mjs`を実行する。

### 自動取得の設定（migration 012）の配置

1. `supabase migration list --linked`と`supabase db push --linked --dry-run`で、未適用が`012_fetch_schedules.sql`だけであることを確認してから適用する（履歴表が無い場合はSQLエディタ等で012だけを実行）。既存の表・行は変更しません。
2. 直後に`review-api`と`agent-api`を配置する（上記の`supabase functions deploy`、`--no-verify-jwt`）。
3. PRをmainへマージし、GitHub Pagesの画面に「自動取得の設定」が出ることを確認する。
4. Grok Botの5分ごとの手順の先頭に`node scripts/agent-queue.mjs --enqueue-due`を追加する（最初は`--dry-run`で内容を確認）。

### 店舗の選択（migration 013）の配置

1. `supabase migration list --linked`と`supabase db push --linked --dry-run`で、未適用が`013_stores.sql`だけであることを確認してから適用する（履歴表が無い場合はSQLエディタ等で013だけを実行）。既存の表・行は変更せず、店舗も作成しません。
2. 直後に`review-api`を配置する（`supabase functions deploy review-api --project-ref ycsqfajidusuibqljjwr --no-verify-jwt`）。`agent-api`・取り込み契約は変わりません。
3. 初期データ（任意・再実行可）: SQLエディタまたは`psql`で`supabase/seed/013_seed_stores.sql`を1回実行する。データを持つ既存の利用者ごとに24店舗（表示順1〜24）を作り、`BISTRO CAVACAVA`に一休`112789`・食べログ`13245351`を設定します。食べログの既定の店舗コード`''`（店舗コードなしの資格情報・旧データ）は、`''`のデータがあり、`13245351`以外の食べログの店舗コードが無い利用者だけ`BISTRO CAVACAVA`に設定します。同名の店舗・設定済みの店舗IDは変更しません。最後の`select`で利用者ごとの店舗数と`BISTRO CAVACAVA`の設定を確認する。
4. PRをmainへマージし、GitHub Pagesでログイン後に店舗の選択画面が出ること、「全店舗」で比較表が出ることを確認する。

### AI分析（migration 014・ai-analyst）の配置

1. `014_ai_reports.sql`だけを適用する（`supabase db query --linked -f supabase/migrations/014_ai_reports.sql`、または`migration list`と`db push --dry-run`で014だけと確認できた場合に限り`db push`）。新しい表`ai_reports`（保存レポート）と`ai_usage`（1時間あたりの回数制限）を作るだけで、既存の表・行は変更しません。
2. OpenAIのAPIキーは**Supabaseの秘密情報（Edge Functionの環境変数）だけ**に置きます。ブラウザ・Git・GitHub Secrets・ログには置きません。値がコマンドラインや画面に出ないよう、権限600の一時ファイル経由で設定して削除します:
   ```sh
   umask 077; f=$(mktemp)
   read -rs -p "OpenAI API key: " k; printf 'OPENAI_API_KEY=%s\n' "$k" > "$f"; unset k; echo
   supabase secrets set --project-ref ycsqfajidusuibqljjwr --env-file "$f"
   rm -P "$f" 2>/dev/null || shred -u "$f" 2>/dev/null || rm -f "$f"
   supabase secrets list --project-ref ycsqfajidusuibqljjwr   # 名前とハッシュだけが表示される
   ```
   任意: `OPENAI_MODEL`（既定`gpt-6-luna`。`gpt-5-mini`なども指定可）、`OPENAI_REASONING_EFFORT`（`none`/`minimal`/`low`/`medium`/`high`。推論モデル＝gpt-5系・gpt-5.x・gpt-6系・o系のみ送信。既定`low`）。
   gpt-6系はChat Completionsで関数（tools）を使うとき`reasoning_effort`に`none`しか受け付けないため、質問への回答（関数呼び出し）では設定に関係なく`none`を送ります。レポート作成（JSON出力）には`OPENAI_REASONING_EFFORT`を使います。`none`はgpt-5.1以降・gpt-6系にだけ送り、gpt-5 / gpt-5-mini / o系では送りません。
3. 関数を配置する: `supabase functions deploy ai-analyst --project-ref ycsqfajidusuibqljjwr --no-verify-jwt`（認証は関数内で`auth.getUser()`、review-apiと同じ）。
4. PRをmainへマージし、GitHub Pagesの「AI分析」で質問・レポート作成ができることを確認する（キー未設定なら画面に「未設定」と表示されます）。

## 配置・運用

PRを作成してテスト成功後にmainへマージすると、GitHub Pagesへ配置されます。Edge Functionsは別途明示的に配置してください（上記コマンド）。
JWTのゲートウェイ検証を無効にしているのは、各関数の処理内で認証（review-api: `auth.getUser()`、agent-api: `INGEST_TOKEN`）を行うためです。認証コードを削除しないでください。
DB変更はこのプロジェクトを確認して対象SQLだけ適用します。`db push`は`migration list`と`--dry-run`で未適用分が対象SQLだけと確認できた場合に限ります。`db reset`は使用しません。
暗号化キーを失うと保存済みパスワードを復号できなくなります。キーの変更は既存データの再暗号化と一緒に行ってください。

`scripts/verify-cloud.mjs`は任意実行の実DB検証です（010/011適用・3関数配置後）。`GOURMET_TEST_SERVICE_KEY`が必要です。一時ユーザー2名を作り、資格情報の暗号化・RLS・取得依頼（重複拒否・取得開始・完了）・取り込みの冪等性・ダッシュボードを確認し、終了時にそのユーザーとテスト行だけを削除します。有効なINGEST_TOKENでagent-apiを呼ばず（本番の利用者へ書き込まないため）、実店舗へのログインも行いません。

## 移行記録

2026-09-29: 旧SNSアプリの現行ファイルをこのダッシュボードへ置換。旧版はGit履歴および`archive/pre-review-dashboard-20260929`タグで復元可能です。
旧サービスの認証ユーザー・保存済み集計データは、旧サービスへのログイン/エクスポートなしには移行できません。コードの置き換えだけで、履歴データまで移ったとは扱わないでください。旧DBのデータは削除していません。

2026-09-29: 一休.comレストランを外部取り込み方式で追加（migration 010、`agent-api`）。資格情報を店舗×サイト単位に変更し、ブラウザからログインIDも読めないようにした。

2026-09-29: すべてのサイトを外部エージェント（Grok Bot）による取り込みへ移行（migration 011）。#11のアプリ内一休公開ページ同期も廃止し、読み取り規則は`scripts/ikyu/public.js`へ移動（取り込みは`stores[].public`）。アプリ内の取得（GitHub Actions `sync-worker.yml`・Playwright ワーカー・`review-worker` の払い出し）を廃止し、アプリ → Grok Bot の取得依頼キュー（`agent_requests`）を追加。食べログの読み取りは `scripts/tabelog/` へ移動。旧 `snapshots` / `reviews` / `source_reports` / `sync_jobs` の履歴は残し、そのまま表示します。

2026-09-29: 店舗×サイトごとの自動取得の設定を追加（migration 012 `fetch_schedules`、`review-api /schedules`、`agent-api /schedules/enqueue-due`、`agent-queue.mjs --enqueue-due`）。

2026-09-29: 店舗マスタと店舗の選択・全店舗の比較を追加（migration 013 `stores`・`store_sites`、初期データ`supabase/seed/013_seed_stores.sql`、`review-api /stores`・`/overview`・`/dashboard?store=`）。

## 参考

- [Supabase Edge Functionsの制限](https://supabase.com/docs/guides/functions/limits)
