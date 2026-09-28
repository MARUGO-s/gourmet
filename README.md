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

GitHubのスケジュールは5分間隔の設定ですが、実際の開始時刻には遅延があり、保証されません。公開リポジトリで60日間活動がないとスケジュールが無効化される場合があります。開始しない場合はActionsの「Collect gourmet metrics」を確認し、必要に応じて再有効化/手動実行してください。
現在、同期ボタンからGitHubを即時起動する仕組みはありません。「開始待ち」には受付時刻・経過時間を表示します。待機が5分以上になっても「取得中」とは表示せず、管理者による手動起動の案内を表示します。
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
- Supabaseの秘密設定: `ENCRYPTION_KEY`と`GOURMET_WORKER_TOKEN`。
- GitHub Actions Secrets: `GOURMET_WORKER_TOKEN`のみ。DBのservice-roleキーや暗号化キーはGitHubに配置しません。
- 自動取得時のみ、そのジョブのID/パスワードをHTTPSでGitHubの一時実行環境へ渡します。スクリーンショット・HTML・認証情報をログや成果物に保存しません。
- クライアント設定のpublishable keyは公開値であり、RLSを必須とします。

スナップショット・口コミ・詳細レポート・完了状態は同一DBトランザクションで保存。取得対象外の過去列を0で上書きせず、抜粋に含まれない過去の口コミは削除しません。処理の再送は冪等、実行中のリースは10分、待ち行列は24時間でタイムアウト扱いになります。

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
