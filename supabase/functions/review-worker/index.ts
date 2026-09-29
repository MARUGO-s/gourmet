// 廃止: アプリ側（GitHub Actions + Playwright）の取得は終了し、すべてのサイトは外部エージェント（Grok Bot）が
// agent-api 経由で取り込む。旧ワーカーが残っていても資格情報の払い出し・保存を行わないよう、常に 410 を返す。
// 関数自体を削除する場合は README「本番化の手順」を参照。
Deno.serve(() => new Response(JSON.stringify({ error: "review-worker is retired; data is ingested by the external agent via agent-api" }), {
  status: 410, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
}));
