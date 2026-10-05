// チーム（migration 024）。Node（テスト）と Edge（review-api・ai-analyst）で共通。
// 持ち主 = Grok Bot の取り込み先（TEAM_OWNER_ID、無ければ INGEST_USER_ID）。データの user_id は持ち主のまま。
//   owner  : 持ち主本人。すべて
//   admin  : 承認済みの管理者。持ち主の全店舗・すべて（メンバーの承認、ログイン情報、店舗管理を含む）
//   member : 承認済みのメンバー。担当店舗だけを見る・設定する（取得依頼・自動取得・口コミ通知）。ログイン情報・店舗管理・メンバー管理・M-talk 送信はできない
//   pending / suspended / none : 申請中・停止・未申請。データは見えない（参加申請の画面だけ）
// 読み込みは本人のJWT（RLS が担当店舗に絞る）。書き込みは役割と担当店舗をここで確かめてから service_role（user_id は持ち主）。
import { isStoreId } from "./stores.js";

export const TEAM_ROLES = ["admin", "member"];
export const TEAM_STATUSES = ["pending", "active", "suspended"];
export const TEAM_NAME_MAX = 100;
const ROLE_LABELS = { owner: "持ち主", admin: "管理者", member: "メンバー" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message) => { throw new Error(message); };

/** 持ち主の user_id（未設定なら null = チームなし。各自が自分のデータの持ち主） */
export function teamOwnerId(env) {
  const v = String(env("TEAM_OWNER_ID") || env("INGEST_USER_ID") || "").trim();
  return UUID.test(v) ? v.toLowerCase() : null;
}

/**
 * 役割の判定。member はチームの行（team_members）、storeIds は担当店舗。
 * @param {{ id: string }} user @param {string | null} ownerId
 * @param {{ id: string, owner_id: string, role: string, status: string } | null | undefined} member @param {string[]} [storeIds]
 */
export function teamContext(user, ownerId, member, storeIds = []) {
  const base = { userId: user.id };
  if (!ownerId || user.id === ownerId) return { ...base, role: "owner", ownerId: user.id, memberId: null, storeIds: null };
  if (!member || member.owner_id !== ownerId) return { ...base, role: "none", ownerId, memberId: null, storeIds: [] };
  if (member.status !== "active") return { ...base, role: member.status === "suspended" ? "suspended" : "pending", ownerId, memberId: member.id, storeIds: [] };
  if (member.role === "admin") return { ...base, role: "admin", ownerId, memberId: member.id, storeIds: null };
  return { ...base, role: "member", ownerId, memberId: member.id, storeIds: [...new Set(storeIds)] };
}

/** 役割ごとにできること */
export function teamPermissions(ctx) {
  const full = ctx.role === "owner" || ctx.role === "admin";
  const active = full || ctx.role === "member";
  return { active, allStores: full, manageCredentials: full, manageStores: full, manageTeam: full, shareMtalk: full,
    // 取得依頼・自動取得・口コミ通知（担当店舗だけ）
    editStoreSettings: active };
}
export const isActive = (ctx) => teamPermissions(ctx).active;

/** 店舗（stores.id）を扱えるか */
export function canUseStore(ctx, storeId) {
  if (!isActive(ctx)) return false;
  if (ctx.storeIds == null) return true;
  return ctx.storeIds.includes(storeId);
}
/** サイトの店舗コード（source・key）を扱えるか。sites は持ち主の store_sites（store_id・source・site_store_key） */
export function canUseSiteKey(ctx, sites, source, key) {
  if (!isActive(ctx)) return false;
  if (ctx.storeIds == null) return true;
  const k = key ?? "";
  return sites.some((s) => s.source === source && (s.site_store_key ?? s.siteStoreKey ?? "") === k && ctx.storeIds.includes(s.store_id ?? s.storeId));
}

/** 画面に返す自分の状態 */
export function publicTeamMe(ctx, member = null) {
  return { role: ctx.role, roleLabel: ROLE_LABELS[ctx.role] ?? null, permissions: teamPermissions(ctx), storeIds: ctx.storeIds,
    displayName: member?.display_name ?? "", requestedAt: member?.requested_at ?? null };
}

export function validateJoinInput(input) {
  const name = typeof input?.displayName === "string" ? input.displayName.normalize("NFC").trim() : "";
  if (!name) fail("お名前（店舗名など）を入力してください");
  if (name.length > TEAM_NAME_MAX) fail(`お名前は${TEAM_NAME_MAX}文字以内で入力してください`);
  return { display_name: name };
}

/**
 * メンバーの変更（役割・状態・担当店舗）。ownerStoreIds は持ち主の店舗。
 * 返り値: { patch: team_members の変更, storeIds: 担当店舗（指定したときだけ。管理者は使わない） }
 */
export function validateMemberUpdate(input, ownerStoreIds) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("入力形式が不正です");
  const patch = {};
  if (input.role != null) { if (!TEAM_ROLES.includes(input.role)) fail("役割が不正です"); patch.role = input.role; }
  if (input.status != null) { if (!TEAM_STATUSES.includes(input.status) || input.status === "pending") fail("状態が不正です"); patch.status = input.status; }
  if (input.displayName != null) patch.display_name = validateJoinInput({ displayName: input.displayName }).display_name;
  let storeIds;
  if (input.storeIds != null) {
    if (!Array.isArray(input.storeIds) || input.storeIds.length > 200 || input.storeIds.some((id) => !isStoreId(id))) fail("担当店舗の指定が不正です");
    storeIds = [...new Set(input.storeIds.map((id) => id.toLowerCase()))];
    const known = new Set(ownerStoreIds.map((id) => id.toLowerCase()));
    if (storeIds.some((id) => !known.has(id))) fail("担当店舗に存在しない店舗が含まれています");
  }
  if (!Object.keys(patch).length && storeIds === undefined) fail("変更する内容がありません");
  return { patch, storeIds };
}

/**
 * 管理者がしてよい変更か。持ち主はすべて。管理者は、管理者の行・管理者への昇格・自分自身は変えられない（持ち主だけ）。
 * @param {{ role: string, userId: string }} ctx @param {{ user_id: string, role: string }} target @param {{ role?: string }} [patch]
 */
export function canManageMember(ctx, target, patch = {}) {
  if (ctx.role === "owner") return true;
  if (ctx.role !== "admin") return false;
  if (target.user_id === ctx.userId) return false;
  if (target.role === "admin" || patch.role === "admin") return false;
  return true;
}

export function publicMember(row, storeIds = []) {
  return { id: row.id, userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role, roleLabel: ROLE_LABELS[row.role],
    status: row.status, requestedAt: row.requested_at, approvedAt: row.approved_at ?? null, updatedAt: row.updated_at, storeIds: row.role === "admin" ? null : storeIds };
}

// ---------- 読み込み（service_role。本人の行だけ） ----------
/** @param {any} admin service_role のクライアント @param {{ id: string }} user @param {string | null} ownerId */
export async function loadTeamContext(admin, user, ownerId) {
  if (!ownerId || user.id === ownerId) return { ctx: teamContext(user, ownerId, null), member: null };
  const { data, error } = await admin.from("team_members").select("id,owner_id,role,status,display_name,requested_at").eq("user_id", user.id).limit(1);
  if (error) throw error;
  const member = data?.[0] ?? null;
  let storeIds = [];
  if (member && member.status === "active" && member.role === "member") {
    const res = await admin.from("team_member_stores").select("store_id").eq("member_id", member.id);
    if (res.error) throw res.error;
    storeIds = (res.data ?? []).map((r) => r.store_id);
  }
  return { ctx: teamContext(user, ownerId, member, storeIds), member };
}
