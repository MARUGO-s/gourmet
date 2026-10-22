# 取得依頼の即時起動（Grok Bot ルーチン Webhook）

アプリ／M-talk からのその場の取得依頼（「今すぐ取得」= review-api `POST /requests`、ログイン情報保存後の取り直し = `queueRefetchAfterSave`）を
`agent_requests` に登録した直後、review-api が Grok Bot ルーチンの Webhook を呼び、すぐ取得を始めてもらう。
自動取得の設定（`origin = 'schedule'`、agent-api `/schedules/enqueue-due`）は呼ばない（毎朝 10:03 のルーチンが処理）。

- 実装: `supabase/functions/_shared/refetch-webhook.js`、呼び出しは `supabase/functions/review-api/index.ts`。
- secrets: `GROKBOT_REFETCH_WEBHOOK_URL`（https のみ）、`GROKBOT_REFETCH_WEBHOOK_KEY`。どちらか未設定なら何もしない。
- 本文: `{ requestId, source, storeId, requestedAt }`（個人情報なし）。
- ヘッダー: `Authorization: Bearer <key>` と `X-Webhook-Key: <key>` の両方（Grok Bot 側の期待ヘッダーは要確認（推測））。
- 待たない（`EdgeRuntime.waitUntil`）・タイムアウト 5 秒。失敗しても依頼は成功のまま、ログは `HTTP 500` / `timeout` / `error` のみ。
- 間引き: 直前 2 分以内に schedule 以外の別の依頼があれば呼ばない（その時に起きたルーチンがまとめて取得する）。

## 長い取得と引き継ぎ（migration 029）

- 取得中（claimed）の期限は最後の claim・延長から30分。40分の引き継ぎなど長い取得では、20分ごとくらいに
  `node scripts/agent-queue.mjs --extend <id> --claim-id <claimId> --token-file ~/.review-agent/ingest_token` を呼んで期限を延ばす。
  409 が返ったら期限切れで戻されているので、`--claim` で取り直す（claimId が変わる）。
- 期限切れで queued に戻された依頼は `released_at` が付き、「24時間拾われない依頼は失敗」の24時間はそこから数える
  （元の依頼時刻から24時間で即失敗にならない）。
- 自動取得（`--enqueue-due`）は、同じ店舗×サイトの未完了の依頼が20時間以上前で作業中でない（依頼中、または取得中で30分以上延長なし）なら、
  その依頼を失敗（kind other、「新しい自動取得の依頼に置き換えました（superseded）」）にして、その日の依頼を新しく作る。応答の `superseded` に置き換えた依頼の id が入る。
