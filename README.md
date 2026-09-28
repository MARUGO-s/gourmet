# gourmet — Review Command Center

口コミ・評価・アクセス・予約指標のダッシュボードです。

- 公開先: https://marugo-s.github.io/gourmet/
- Supabase: `gourmet` / `ycsqfajidusuibqljjwr`
- 構成: React/Vite → Supabase Auth + Edge Functions + PostgreSQL → GitHub Actions/Playwright
- 現在の自動取得対象: 食べログの店舗管理画面。他サイトの接続定義は調整前です。
- 未ログイン時の数字は読み取り専用のデモです。ログインすると自身の実データだけを表示します。

## 利用手順

1. 右上「ログイン」→「新規登録」でgourmet専用アカウントを作成します。届いた確認メールのリンクを開いてください。
2. 「アカウント管理」に食べログの**店舗管理用ID/パスワード**を登録します。一般会員メール/価格.com IDではありません。
3. 「食べログを同期」を押します。「依頼を送信中…」→「開始待ち」→「取得中…」の順に進みます。開始待ちはまだサイトにアクセスしていません。ページやPCを閉じても依頼は保持されます。
4. 完了・警告・失敗理由は同期パネルに表示されます。1時間4回まで、同じ利用者の重複実行は防止します。

同期ボタンで依頼を保存した直後、サーバーからGitHub Actionsへ起動を要求します。起動要求の成功は取得開始・成功を意味しません。実行環境の準備中は「開始待ち」、ジョブを実行環境が受け取って初めて「取得中」と表示します。開始時刻はGitHubの混雑次第で遅れる場合があります。
起動要求の失敗やキー未設定は待機中のパネルに表示します。5分間隔の定期実行は補助経路として残しますが、開始時刻の保証はありません。20分以内に開始しない依頼はタイムアウトで終了し、再試行できる状態に戻ります。完了・失敗の結果は画面を開き直した場合も表示します。
公開リポジトリで60日間活動がないと定期実行が無効化される場合があります。開始しない場合はActionsの「Collect gourmet metrics」と接続キーの有効期限・権限を確認してください。
追加認証・CAPTCHA・サイト側のアクセス制限は回避しません。認証・取得エラーを表示し、それまでの数値は残します。サイトの利用条件とアカウントの権限を確認して使用してください。

## 開発

Node.js 22:

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
```

ローカルURL: `http://localhost:5173/gourmet/`。公開設定はコードに含まれ、ローカルも同じgourmet Supabaseにつながります。変更検証中に本番アカウントの同期を不用意に開始しないでください。

## データと秘密情報

テーブル: `credentials`, `snapshots`, `reviews`, `sync_log`, `source_reports`, `sync_jobs`。
RLSで利用者ごとに分離。ブラウザからは自身のデータのみ読み取り可能、パスワードの暗号文も取得できません。
書き込みは認証済みAPIに限定。評価列は`numeric(4,2)`、すべてのサイトの評価表示を小数点第2位に統一。

- `review-api`: JWTを`auth.getUser()`で検証。公開はデモとサイト一覧のみ。
- `review-worker`: 専用`GOURMET_WORKER_TOKEN`で認証。ジョブのリース番号を確認して結果を保存。
- Supabaseの秘密設定: `ENCRYPTION_KEY`、`GOURMET_WORKER_TOKEN`、`GOURMET_DISPATCH_TOKEN`。
- `GOURMET_DISPATCH_TOKEN`: gourmetリポジトリ1件だけ、Actions read/write + 必須Metadata readに限定したfine-grained PAT。個人の広い権限のCLIトークンは転用しません。ブラウザ・Git・GitHub Secretsには配置しません。期限切れ前に同じ範囲のキーへ更新します。
- GitHub Actions Secrets: `GOURMET_WORKER_TOKEN`のみ。DBのservice-roleキーや暗号化キーはGitHubに配置しません。
- 自動取得時のみ、そのジョブのID/パスワードをHTTPSでGitHubの一時実行環境へ渡します。スクリーンショット・HTML・認証情報をログや成果物に保存しません。
- クライアント設定のpublishable keyは公開値であり、RLSを必須とします。

スナップショット・口コミ・詳細レポート・完了状態は同一DBトランザクションで保存。取得対象外の過去列を0で上書きせず、抜粋に含まれない過去の口コミは削除しません。処理の再送は冪等、実行中のリースは10分、開始待ちは20分でタイムアウト扱いになります。

## 起動経路の設計

`ログイン済みの同期操作 → 利用者別の依頼保存 → 固定されたGitHub workflowへ起動要求 → リース取得 → 取得・検証 → 一括保存 → 画面反映`

- ユーザーが起動先URL・リポジトリ・ブランチを指定することはできません。起動先は `MARUGO-s/gourmet` / `sync-worker.yml` / `main` 固定。
- 同じ依頼の起動要求はDBで2分間隔に制限します。1利用者1実行、1時間4回の既存制限も維持します。
- GitHub応答待ちは10秒で打ち切り、応答が不明でも依頼自体は失いません。定期実行と二重に起動してもリースで重複取得を防ぎます。
- GitHub実行環境の準備があるため即時に数値が出る設計ではありません。利用者が増えた場合は常駐ワーカーとGitHub Appの短期トークンへの切替を再検討します。
- Actionsが実行できても取得失敗時は実行結果を赤にします。成功判定はDBの保存結果で行い、Actionsの開始だけでは成功扱いにしません。

公開ページの読み取りはJSON-LDと店舗ヘッダーだけを対象にし、HTTP 403や追加認証を検出したら停止します。プロキシ・偽装・CAPTCHA回避はしません。`Collect gourmet metrics` の `public_diagnostic=true` は公開ページだけを診断する運用モードです。ログイン・DBアクセスはせず、HTTP状態と抽出成否のみを出力します。

## 配置・運用

PRを作成してテスト成功後にmainへマージすると、GitHub Pagesへ配置されます。Edge Functionsは別途明示的に配置してください。

```sh
supabase functions deploy review-api --project-ref ycsqfajidusuibqljjwr --no-verify-jwt
supabase functions deploy review-worker --project-ref ycsqfajidusuibqljjwr --no-verify-jwt
```

JWTのゲートウェイ検証を無効にしているのは、上記の認証を処理内で実施するためです。認証コードを削除しないでください。
DB変更はこのプロジェクトを確認して対象SQLだけ適用します。共有DBでの一括`db push`/`db reset`は使用しません。
暗号化キーを失うと保存済みパスワードを復号できなくなります。キーの変更は既存データの再暗号化と一緒に行ってください。

`scripts/verify-cloud.mjs`は任意実行の実DB検証です。`GOURMET_TEST_SERVICE_KEY`と専用worker tokenが必要です。処理中のジョブがある環境では実行しません。一時ユーザー2名を作り、終了時にそのユーザーとテスト行だけを削除します。実店舗へのログインは行いません。

## 移行記録

2026-09-29: 旧SNSアプリの現行ファイルをこのダッシュボードへ置換。旧版はGit履歴および`archive/pre-review-dashboard-20260929`タグで復元可能です。
旧サービスの認証ユーザー・保存済み集計データは、旧サービスへのログイン/エクスポートなしには移行できません。コードの置き換えだけで、履歴データまで移ったとは扱わないでください。旧DBのデータは削除していません。

## 参考

- [GitHub Actionsのスケジュール制約](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Supabase Edge Functionsの制限](https://supabase.com/docs/guides/functions/limits)
