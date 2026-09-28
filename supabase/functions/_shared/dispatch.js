// No user-controlled URL, repository, branch, workflow, or credential forwarding.
export async function dispatchWorker(token, fetcher = fetch) {
  if (!token) return { status: "unconfigured", message: "即時起動の接続キーが未設定です。定期実行を待っています。管理者に設定確認を依頼してください" };
  try {
    const response = await fetcher("https://api.github.com/repos/MARUGO-s/gourmet/actions/workflows/sync-worker.yml/dispatches", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
      body: JSON.stringify({ ref: "main" }),
    });
    if (response.status === 200 || response.status === 204) return { status: "requested", message: "取得用サーバーへ起動を依頼しました。準備が終わると取得を開始します" };
    // Do not return GitHub response bodies, tokens, or stack traces.
    return { status: "failed", message: `即時起動の依頼に失敗しました（HTTP ${response.status}）。定期実行を待っています。管理者に接続キー・Actions設定の確認を依頼してください` };
  } catch {
    return { status: "failed", message: "起動依頼の応答を確認できませんでした。依頼は保存済みです。定期実行での開始も待っています" };
  }
}
