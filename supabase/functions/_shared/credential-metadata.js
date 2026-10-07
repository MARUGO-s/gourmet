// 認証済み管理者向けの登録状態。秘密の列・所有者IDはレスポンスに含めない。
export const CREDENTIAL_METADATA_COLUMNS = "id,user_id,source,label,store_key,credentials_version,updated_at";

export function publicCredentialMetadata(row, actorId) {
  return {
    id: row.id, source: row.source, label: row.label, storeKey: row.store_key,
    credentialsVersion: row.credentials_version, updatedAt: row.updated_at,
    canDelete: !!actorId && row.user_id === actorId,
  };
}
