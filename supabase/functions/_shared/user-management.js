// JWTで認証されたclientをそのままRPCへ渡す。DBがauth.uid()の現在の権限を検証する。
export async function userManagement(client, path, method, input, page = "1") {
  let result;
  if (path === "/me" && method === "GET") {
    result = await client.rpc("gourmet_my_access");
  } else if (path === "/users" && method === "GET") {
    if (!/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000) return { status: 400, data: { error: "ページの指定が不正です" } };
    result = await client.rpc("gourmet_list_users", { p_page: Number(page) });
  } else if (path === "/users/admin" && method === "POST") {
    if (!input || typeof input.userId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.userId) || typeof input.enabled !== "boolean") {
      return { status: 400, data: { error: "ユーザーと権限の指定が不正です" } };
    }
    result = await client.rpc("gourmet_set_admin", { p_target: input.userId, p_enabled: input.enabled });
  } else if (path === "/users/access" && method === "POST") {
    if (!input || typeof input.userId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.userId) || !["approved", "revoked"].includes(input.status)) {
      return { status: 400, data: { error: "ユーザーと閲覧権限の指定が不正です" } };
    }
    if (!Array.isArray(input.storeIds) || input.storeIds.length > 200 || input.storeIds.some(id => typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
      return { status: 400, data: { error: "閲覧を許可する店舗の指定が不正です" } };
    }
    result = await client.rpc("gourmet_set_access", { p_target: input.userId, p_status: input.status, p_stores: input.storeIds });
  } else if (path === "/users/delete" && method === "POST") {
    if (!input || typeof input.userId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.userId) || typeof input.email !== "string" || !input.email || input.email.length > 320) {
      return { status: 400, data: { error: "削除対象と確認用メールアドレスを指定してください" } };
    }
    result = await client.rpc("gourmet_delete_user", { p_target: input.userId, p_email: input.email });
  } else return { status: 404, data: { error: "ページが見つかりません" } };
  if (!result.error) return { status: 200, data: result.data };
  const status = { P0400: 400, P0403: 403, P0404: 404, P0409: 409 }[result.error.code];
  return { status: status ?? 500, data: { error: status ? result.error.message : "ユーザー管理を処理できませんでした。時間をおいて再度お試しください" } };
}

export async function viewingAccess(client) {
  const { data, error } = await client.rpc("gourmet_can_view");
  if (error) return { status: 503, data: { error: "利用権限を確認できませんでした。時間をおいて再度お試しください" } };
  if (data !== true) return { status: 403, data: { error: "このアカウントは閲覧できません。管理者の承認をお待ちください" } };
  return null;
}
