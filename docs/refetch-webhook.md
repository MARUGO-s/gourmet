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
