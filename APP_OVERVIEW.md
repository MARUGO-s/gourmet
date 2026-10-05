# gourmet アプリ概要（APP_OVERVIEW）

最終更新: 2026-10-05（週報 HTML を全サイト共通テンプレート化し、一休週報を追加。UI=サンプル週報、内容=青写真ルール）。詳しい手順・API の入出力は [README.md](README.md) を見てください。

## 1. 目的

複数店舗（初期データ 24 店舗。例: BISTRO CAVACAVA＝一休 `112789`・食べログ `13245351`）の **口コミ・評価・アクセス（PV）・予約指標** を 1 か所で見て、AI に質問・レポート作成をさせ、M-talk（社内チャット、line_report）からも同じデータで答えるためのダッシュボードです。

- 公開先: https://marugo-s.github.io/gourmet/ （GitHub Pages。main へのマージで配置）
- Supabase プロジェクト: `gourmet`（`ycsqfajidusuibqljjwr`）
- 構成: React + Vite（`src/`）→ Supabase Auth ＋ Edge Functions（`supabase/functions/`）＋ PostgreSQL
- **アプリ自身はどのサイトにもログイン・取得しません。** 取得はすべて外部エージェント Grok Bot（SiteBot）が、ふつうの Chrome の画面操作で行います。

## 2. 画面（左のメニュー）

| 画面 | 内容 |
|---|---|
| 全店舗の比較 | 店舗ごとの PV・予約・口コミ・評価の比較表（ログイン時のみ） |
| ダッシュボード | 選んだ店舗の KPI、アクセスの推移、口コミ一覧、一休・食べログの詳細（端末別 PV・来店指標・エリア順位・ページ別 PV など）。未ログイン時はデモの数字 |
| AI分析 | 質問への回答（`/ask`）と、保存できる AI レポート。レポートは M-talk の利用者へカード＋PDF で送れる。回答の最後にデータの取得日時・期間が付く |
| 取得依頼 | 店舗×サイトごとの「今すぐ取得を依頼」と履歴（依頼中→取得中→完了／失敗）。ログイン情報の問題なら「ログイン情報を更新」ボタン |
| 自動取得の設定 | 店舗×サイトごとの定期取得（`fetch_schedules`） |
| 口コミ通知 | 新着口コミ・食べログ総合点の変化を M-talk の店舗 Bot で送る設定と送信履歴 |
| アカウント管理 | 店舗×サイトのログイン情報の登録（暗号化して保存。ブラウザからは読み返せない） |
| 店舗管理 | 店舗名・表示順・各サイトの店舗 ID |

## 3. データの流れ

```
（取得の合図）アプリ「今すぐ取得を依頼」/ 自動取得の設定 / ログイン情報の保存後の取り直し
   → agent_requests（queued）
Grok Bot（ルーチン。約5分ごと）
   → agent-api /schedules/enqueue-due → /requests/pending・/requests/claim
   → /credentials/fetch（ログイン情報。記録つき）
   → computerUse でふつうの Chrome を操作し、管理画面にログイン・ページを保存（ログインは1回の取得につき1回）
   → 解析できるページ: scripts/ikyu-html-to-json.mjs / tabelog-html-to-json.mjs → agent-api /ingest（1トランザクション）
   → 解析しないページ: scripts/page-snapshots.mjs send → agent-api /pages/ingest（site_page_snapshots、service_role だけ）
   → /requests/complete または /requests/fail（失敗の種類つき）
DB（Postgres、RLS で利用者ごとに分離）
   → アプリ: review-api（ダッシュボード・比較）、ai-analyst（/ask・レポート）
   → M-talk: line_report の mtalk-external-post /chat-dispatch → ai-analyst /mtalk-chat → Bot が回答を投稿
   → 口コミ通知: DB トリガー → agent-api が line_report /alert へ送信
```

AI は **キャッシュ（取り込み済みの DB）だけ** で答え、質問のたびにサイトへ取りに行きません。

## 4. DB のテーブル

| 区分 | テーブル |
|---|---|
| ログイン情報 | `credentials`（店舗×サイト、暗号化）、`credential_access_log` |
| 取り込み（共通） | `source_stores`、`source_daily_metrics`、`source_monthly_metrics`、`source_reviews`、`agent_reports`（エリア順位・ページ別 PV・端末別ページサマリーなど）、`agent_ingest_runs` |
| 一休 | `ikyu_stores`、`ikyu_daily_pageviews`（日付別アクセス：PV・予約件数・金額）、`ikyu_monthly_pageviews`、`ikyu_reviews`、`ikyu_ingest_runs` |
| 保存HTML（022） | `site_page_snapshots`（店舗×サイト×ページ×期間で最新1件。service_role だけ。予約者の個人情報を含むページは `contains_pii`・120日で削除） |
| 取得依頼・自動取得 | `agent_requests`（`origin`・`failure_kind`）、`fetch_schedules` |
| 店舗 | `stores`、`store_sites` |
| AI | `ai_reports`、`ai_usage`（回数制限。M-talk は `kind='mtalk'`）、`ai_report_shares` |
| M-talk | `mtalk_live_lookups`（旧「最新を調べる」の記録。022 以降は新しく作らない）、`mtalk_followups`（再ログイン後のお知らせ） |
| 口コミ通知 | `review_alert_settings`、`review_alert_events`、`review_alert_deliveries` |
| 旧データ（読み取りのみ） | `snapshots`、`sync_log`、`reviews`、`source_reports`、`sync_jobs` |

ブラウザは自分の行の SELECT だけ（`agent_requests` は本人の依頼の INSERT も可）。パスワードの暗号文・`claim_id`・保存HTMLは読めません。

## 5. Edge Functions とエンドポイント

| 関数 | 認証 | 主なエンドポイント |
|---|---|---|
| `review-api` | 利用者の JWT（`auth.getUser()`） | `/dashboard`、`/overview`、`/sources`、`/stores`・`/stores/reorder`、`/credentials`、`/requests`、`/schedules`、`/alert-settings`、`/alert-log`。`/sync` は廃止（410） |
| `ai-analyst` | `/ask` 等は JWT。`/mtalk-chat` は `GOURMET_MTALK_TOKEN` の HMAC 署名 | `/ask`、`/reports`（作成・一覧）、`/reports/:id/share-mtalk`、`/shares`、`/mtalk-recipients`、`/status`、`/mtalk-chat` |
| `agent-api` | `X-Ingest-Token`（`INGEST_TOKEN`）。対象の利用者は `INGEST_USER_ID` で固定 | `/ingest`、`/ikyu/ingest`、`/pages/ingest`、`/credentials/versions`、`/credentials/fetch`、`/requests/pending`・`/claim`・`/complete`・`/fail`、`/schedules/enqueue-due`、`/alerts/dispatch` |
| `review-worker` | ― | 廃止（常に 410） |

すべて `--no-verify-jwt` で配置し、認証は関数の中で行います。

秘密情報（名前だけ。値は Supabase の secrets にだけ置く）: `ENCRYPTION_KEY`、`INGEST_TOKEN`、`INGEST_USER_ID`、`OPENAI_API_KEY`（任意: `OPENAI_MODEL`、`OPENAI_REASONING_EFFORT`）、`GOURMET_MTALK_TOKEN`、`MTALK_API_URL`。Supabase が自動で入れる値: `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。Grok Bot 側は `~/.review-agent/ingest_token`。GitHub Actions の Secrets は不要です。

## 6. migration 一覧（`supabase/migrations/`）

| 番号 | 内容 |
|---|---|
| 001 | ダッシュボードの基本スキーマ |
| 002 | 評価を小数点第2位に |
| 003 | `source_reports` |
| 004〜007 | 旧アプリ内取得のキュー（`sync_jobs` など。廃止済み） |
| 008 | 店舗の口コミ |
| 009 | 一休の公開ページ同期（廃止済み） |
| 010 | 一休の取り込みと店舗×サイトのログイン情報 |
| 011 | 外部エージェントの取り込み（`source_*`・`agent_reports`）と取得依頼 `agent_requests` |
| 012 | 自動取得の設定 `fetch_schedules` |
| 013 | 店舗マスタ `stores`・`store_sites` |
| 014 | AI レポート `ai_reports`・`ai_usage` |
| 015 | レポートの M-talk 送信 `ai_report_shares` |
| 016 | M-talk からの質問の回数制限 |
| 017 | 口コミ通知 |
| 018 | 口コミ通知を店舗 Bot・グループのルームへ |
| 019 | M-talk の「最新を調べる／今あるデータで答える」（022 で廃止） |
| 020 | ログインの失敗の種類 `failure_kind`・`mtalk_followups` |
| 021 | `needs_relogin` はサイトの表示があるときだけ |
| 022 | 保存HTML `site_page_snapshots`・`save_site_page_snapshots`・`purge_site_page_snapshots`、進行中の「最新を調べる」を閉じる |

適用は対象の SQL だけ（`supabase db query --linked -f supabase/migrations/<番号>_….sql`）。`db reset` は使いません。

## 7. ルーチン（Grok Bot）の動き

手順書は `/workspace/routine-prompt-cache.next.md`（022 以降）。要点:

- 作業場所 `/workspace/gourmet`（main、毎回 `git pull --ff-only`）。
- ブラウザ操作はいちばん上の実行が computerUse で自分で行う。Playwright・CDP・スクリプト・curl でのサイト取得、Cookie の持ち出しはしない。
- ログインは1回の取得につき1回まで。Cloudflare などの「私は人間です」はチェックを1回押すだけで、画像パズルは解かない。2段階認証は止める。
- 一休でログインできなかった日は、その日のうちは一休へのログインを試さない（`/workspace/run-state/ikyu-login-stop.txt`）。
- 1回のログインで当月・前月の分析・統計・予約・プランのページをまとめて保存する（`node scripts/page-snapshots.mjs list`）。解析できるページは取り込み、ほかは保存HTMLとして送る。アカウント・支払い・API トークンのページは保存しない。
- 失敗は `--fail --kind needs_relogin|needs_human_check|other` で報告。M-talk へは自分で送らない。

## 8. M-talk 連携と通知

- **AI分析 Bot への質問**（line_report の `chat_messages` → `/chat-dispatch` → ai-analyst `/mtalk-chat`）: あいさつ・使い方にもデータの質問にもすぐ答える（022 で選択カード・取得待ち・20分の見張りを廃止）。答えの最後に「データ：一休 10/1 18:30取得（9/1〜9/30）」のようにサイトごとの取得日時と期間を付け、36時間を超えたら古いこと、取り込みが無いサイトはわからないことをはっきり書く。古いカードのボタンや「1」「2」には、2時間以内の質問ならその質問に答え、無ければ「そのまま質問を送ってください」と返す。
- **ログイン情報の問題**: 直近の取得が `needs_relogin` なら「ログイン情報を更新」ボタン（アプリの登録画面を開くだけ。パスワードは M-talk に書かせない）。保存すると取り直しの依頼が自動で入る。
- **AI レポートの送信**: アプリから M-talk の利用者1人へ、要点カード＋PDF。
- **口コミ通知**: 新着口コミ・食べログ総合点の変化を、店舗の M-talk 店舗 Bot が参加しているグループのルームへ（店舗ごとに1通、二重送信防止つき）。
- 署名: `GOURMET_MTALK_TOKEN` による HMAC（`X-Mtalk-Timestamp`±5分・`X-Mtalk-Signature`）。M-talk へ送る文は内部の言葉（computerUse・executor など）を含む行を落とす。失敗の文は決まった文だけ（`_shared/failure-text.js`）。

## 9. アンチハルシネーションのルール

- AI は SQL を受け取らず、決まったデータ関数（PV・予約・売上・PV の内訳・月別のコンバージョン率・口コミ・詳細レポート・週次PV窓・公開プロフィール・予約通知・競合/ジャンル順位・ニューオープン・データの鮮度など）の結果だけを根拠にする。読むのは本人の行だけ（`scopedReadClient`）。
- 回答の数字はサーバーが関数の結果と照合し（`_shared/answer-verify.js`）、合わない行は落とす。
- 見込み・推測は「（推測）」「（予想）」と付けた行だけ。事実の行と混ぜない。
- 未取得は「未取得」「わからない」と書き、0 と区別する。比べる期間が無ければ「比較データなし」。
- データの鮮度（取得日時・取り込み済みの範囲・期間の日別の欠け・36時間超・取り込みなし・直近の失敗）はサーバーが付ける（AI に書かせない）。
- アプリの AI分析は、口コミも画面で選択中の期間で答える。全期間は質問が「全期間」「これまで」などとはっきり求めたときだけ（サーバーが判断。それ以外は参考の全期間の件数だけ）。M-talk は画面の期間が無いので、「悪い口コミ」などは全期間で答える。
- 予約者の名前・電話番号などの個人情報は AI・アプリ・M-talk に渡さない。

## 10. 対応サイトと状況

| サイト | 状況 |
|---|---|
| 一休.comレストラン | Grok Bot が取得。日付別アクセス（PV・予約件数・金額＝受付日ベース）・月別 PV・口コミを解析。販売集計（プラン別・日付別・前年比）、予約一覧、プラン・コース・在庫・席・タイムセール・キャンセルポリシー・直前割は保存HTMLのみ（未解析） |
| 食べログ | Grok Bot が取得。日別・端末別 PV、月別アクセス・来店指標（ネット予約・通話成立・地図印刷）、エリア順位、ページ別 PV、マイレポートの端末別ページサマリー、口コミ・ピックアップ、公開ページの保存数・予算、管理トップの予約通知件数、公開エリア×ジャンル順位・競合・ニューオープンを解析/構造化。電話効果・端末別の日別ページ・求人・予約実績・キャンセル料請求・コース・座席・空席・クーポン・店舗管理トップHTMLは保存HTMLのみ（トップは件数のみ構造化可） |
| ホットペッパー・Google・トレタ・Retty | 共通の取り込み形式で送られたデータを表示するだけ（Grok Bot 側の取得手順は未実装） |

## 11. 週報 HTML（全サイト共通テンプレート）

週報 HTML の見た目は **全サイト共通** の `scripts/shared/weekly-report.js`（`renderWeeklyReportHtml`、CSS は `scripts/shared/weekly-report.css.txt`）。UI はユーザー承認済みのサンプル週報（hero / KPI / panels / charts / competitor bars / actions / footnotes）、内容ルールは青写真（未取得は「未取得」、事実と推測を分離、PII 禁止）。サイトごとの数値・文言は各アダプタが詰めるだけで、食べログ・一休・今後のホットペッパー等はすべて同じ見た目になります。エージェント／ローカルで HTML を作る（Edge Functions は使わない）。

| サイト | アダプタ | エクスポート入口 |
|---|---|---|
| 食べログ | `scripts/tabelog/weekly-report.js` | `node scripts/tabelog-weekly-report.mjs --input … --out …` |
| 一休 | `scripts/ikyu/weekly-report.js`（取り込み JSON・DB 行から組み立て。予約は受付日ベース。競合・エリア順位は未取得） | `node scripts/ikyu-weekly-report.mjs --payload payload.json --store 112789 --name … --out …` |
| 共通 CLI | — | `node scripts/weekly-report.mjs --site tabelog\|ikyu …` |

詳細は [docs/weekly-report.md](docs/weekly-report.md)（共通・一休）と [docs/tabelog-weekly-report.md](docs/tabelog-weekly-report.md)（食べログ）。

## 12. 残課題

- 保存HTMLだけのページ（上の表）は、本物のサンプルがそろってから解析を足す（`parsed_at` が空のものが対象）。
- 一休の販売集計（プラン別・日付別）の URL は本番の画面でまだ確かめていない。
- 一休週報の競合比較・エリア順位・新規オープン・比較店のプラン価格は「未取得」（一休の公開一覧・プランの取得が未対応）。
- 食べログのネット予約の管理一覧はメニューに無く、未対応。
- 022 以降、鮮度から出る「ログイン情報を更新」で保存しても、取り直しの結果のお知らせ（`mtalk_followups`）は旧 `mtalk_live` の依頼のときだけ作られる（取り直し自体は行われ、次の質問の鮮度に反映される）。
- 一休のログインが「ID・パスワードが正しくありません」と出る件（9/30・10/1。ログイン情報は未変更の可能性）は様子見。続く日は一休のログインを止める。
- ホットペッパー・Google・トレタ・Retty の取得手順。
