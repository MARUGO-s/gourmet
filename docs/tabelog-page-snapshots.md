# 食べログ page-snapshots / 公開フェッチ一覧

ルーチン（Grok Bot）が「どのページを開いて保存／構造化するか」の参照。実装は `supabase/functions/_shared/page-snapshots.js`。

## 管理画面（owner.tabelog.com）— `PAGE_CATALOG.tabelog`

`node scripts/page-snapshots.mjs list --source tabelog --store 13245351` で当月・前月の URL 一覧が出ます。

| page | status | PII | 用途 |
|------|--------|-----|------|
| `tabelog_owner_home` | raw | **yes** | トップ「新着ご予約情報」。HTML は raw 保存。件数のみ `scripts/tabelog/owner-home.js` → `agent_reports.reservation_notices`（氏名等は取り込まない） |
| `tabelog_access_total_daily` ほか | parsed / raw | 既存どおり | 既存（PV・来店指標・ランキング・口コミなど） |
| `tabelog_reservation_results` / `tabelog_cancel_history` | raw | **yes** | 予約者 PII。**AI・構造化禁止** |

アカウント・支払い・API トークン等は `NEVER_SAVE`（カタログ外は受け付けない）。

## 公開（tabelog.com）— `PUBLIC_FETCH_CATALOG`

**`/pages/ingest` には送らない**（ホストは owner のみ許可）。公開取得 → 構造化 JSON を `/ingest`（`agent_reports`）へ。

| page | 構造化先 | パーサ |
|------|----------|--------|
| `tabelog_public_store` | `public_profile`（+ summary の rating/reviews） | `scripts/tabelog/public.js` |
| `tabelog_public_rank_genre` | `public_genre_ranking` | `scripts/tabelog/public-lists.js`（広告枠スキップ） |
| `tabelog_public_rank_newopen` | `public_new_opens` | 同上 + 各店 `openedOn` |

店舗ごとのエリア・ジャンル・URL 組み立て: `scripts/tabelog/store-config.js` の `publicFetchPlan(storeKey)`。

### BISTRO CAVA CAVA（13245351）設定（要 live 確認）

- エリア表示名: 曙橋・四ツ谷三丁目 / 四ツ谷 / 市ヶ谷
- ジャンル: ビストロ (`bistro`) / ワインバー (`winebar`) / フレンチ (`french`)
- 競合 cap: 上位 5 + 自店
- エリア path はサンプル週報ベースの仮置き。本番 URL はブラウザで確認して `store-config.js` を更新すること。

## 週報 HTML

`scripts/tabelog/weekly-report.js` の `buildWeeklyReportHtml` / `assembleWeeklyReportInput`。オフライン（外部 CDN なし）。通話成立≠予約確定、通知件数≠期間合計、公開ページに投稿日なし、を脚注に明記。
