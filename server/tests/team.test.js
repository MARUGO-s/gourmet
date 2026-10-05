// チーム（migration 024・_shared/team.js）の役割・担当店舗・メンバー変更の判定。RLS 自体は supabase/tests/024_team_rls.sql（ローカルDB）で確かめる。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canManageMember, canUseSiteKey, canUseStore, publicMember, publicTeamMe, teamContext, teamOwnerId, teamPermissions, validateJoinInput,
  validateMemberUpdate } from "../../supabase/functions/_shared/team.js";

const OWNER = "00000000-0000-0000-0000-00000000000a";
const S1 = "10000000-0000-0000-0000-000000000001", S2 = "10000000-0000-0000-0000-000000000002";
const user = (id) => ({ id });
const row = (o) => ({ id: "m1", owner_id: OWNER, role: "member", status: "active", ...o });
const sites = [
  { store_id: S1, source: "tabelog", site_store_key: "T1" }, { store_id: S1, source: "ikyu", site_store_key: "111111" },
  { store_id: S2, source: "tabelog", site_store_key: "T2" },
];

test("持ち主は TEAM_OWNER_ID、無ければ INGEST_USER_ID。どちらも無ければチームなし（各自が自分のデータの持ち主）", () => {
  assert.equal(teamOwnerId((k) => ({ INGEST_USER_ID: OWNER.toUpperCase() })[k]), OWNER);
  assert.equal(teamOwnerId((k) => ({ TEAM_OWNER_ID: "00000000-0000-0000-0000-0000000000ff", INGEST_USER_ID: OWNER })[k]), "00000000-0000-0000-0000-0000000000ff");
  assert.equal(teamOwnerId(() => undefined), null);
  assert.equal(teamOwnerId(() => "not-a-uuid"), null);
  assert.equal(teamContext(user("u1"), null, null).role, "owner");
});

test("役割: 持ち主・管理者は全店舗とすべて、メンバーは担当店舗だけ、申請中・停止・未申請は何もできない", () => {
  const owner = teamContext(user(OWNER), OWNER, null);
  const admin = teamContext(user("u2"), OWNER, row({ role: "admin" }));
  const member = teamContext(user("u3"), OWNER, row({}), [S1, S1]);
  const pending = teamContext(user("u4"), OWNER, row({ status: "pending" }), [S1]);
  const stopped = teamContext(user("u5"), OWNER, row({ status: "suspended" }), [S1]);
  const none = teamContext(user("u6"), OWNER, null);
  const otherTeam = teamContext(user("u7"), OWNER, row({ owner_id: "00000000-0000-0000-0000-0000000000ff" }));
  assert.deepEqual([owner, admin, member, pending, stopped, none, otherTeam].map((c) => c.role), ["owner", "admin", "member", "pending", "suspended", "none", "none"]);
  assert.deepEqual(member.storeIds, [S1]);
  assert.equal(admin.ownerId, OWNER);
  assert.equal(member.ownerId, OWNER);
  for (const c of [owner, admin]) assert.deepEqual(teamPermissions(c), { active: true, allStores: true, manageCredentials: true, manageStores: true, manageTeam: true, shareMtalk: true, editStoreSettings: true });
  assert.deepEqual(teamPermissions(member), { active: true, allStores: false, manageCredentials: false, manageStores: false, manageTeam: false, shareMtalk: false, editStoreSettings: true });
  for (const c of [pending, stopped, none]) assert.equal(teamPermissions(c).active, false);
  assert.deepEqual(pending.storeIds, [], "申請中は担当店舗が残っていても使えない");
});

test("担当店舗: メンバーは担当店舗とそのサイトの店舗コードだけ。持ち主・管理者はすべて。承認前はどれも不可", () => {
  const member = teamContext(user("u3"), OWNER, row({}), [S1]);
  assert.equal(canUseStore(member, S1), true);
  assert.equal(canUseStore(member, S2), false);
  assert.equal(canUseSiteKey(member, sites, "tabelog", "T1"), true);
  assert.equal(canUseSiteKey(member, sites, "ikyu", "111111"), true);
  assert.equal(canUseSiteKey(member, sites, "tabelog", "T2"), false, "他店舗のコード");
  assert.equal(canUseSiteKey(member, sites, "tabelog", "T9"), false, "どの店舗にも割り当てていないコード");
  assert.equal(canUseSiteKey(member, sites, "tabelog", ""), false);
  assert.equal(canUseSiteKey(member, sites, "ikyu", "T1"), false, "サイトが違う");
  const admin = teamContext(user("u2"), OWNER, row({ role: "admin" }));
  assert.equal(canUseSiteKey(admin, [], "tabelog", "T9"), true);
  assert.equal(canUseStore(admin, S2), true);
  const pending = teamContext(user("u4"), OWNER, row({ status: "pending" }), [S1]);
  assert.equal(canUseStore(pending, S1), false);
  assert.equal(canUseSiteKey(pending, sites, "tabelog", "T1"), false);
});

test("メンバーの変更: 役割・状態（承認・停止）・担当店舗を検証し、持ち主の店舗以外は拒否", () => {
  assert.deepEqual(validateMemberUpdate({ status: "active", storeIds: [S1.toUpperCase(), S1] }, [S1, S2]), { patch: { status: "active" }, storeIds: [S1] });
  assert.deepEqual(validateMemberUpdate({ role: "admin" }, [S1]), { patch: { role: "admin" }, storeIds: undefined });
  assert.deepEqual(validateMemberUpdate({ storeIds: [] }, [S1]), { patch: {}, storeIds: [] });
  assert.throws(() => validateMemberUpdate({ storeIds: ["10000000-0000-0000-0000-000000000009"] }, [S1]), /存在しない店舗/);
  assert.throws(() => validateMemberUpdate({ storeIds: ["x"] }, [S1]), /担当店舗の指定が不正/);
  assert.throws(() => validateMemberUpdate({ role: "owner" }, [S1]), /役割が不正/);
  assert.throws(() => validateMemberUpdate({ status: "pending" }, [S1]), /状態が不正/);
  assert.throws(() => validateMemberUpdate({}, [S1]), /変更する内容がありません/);
  assert.throws(() => validateMemberUpdate(null, [S1]), /入力形式/);
  assert.deepEqual(validateJoinInput({ displayName: "  渋谷店 店長 " }), { display_name: "渋谷店 店長" });
  assert.throws(() => validateJoinInput({ displayName: " " }), /お名前/);
  assert.throws(() => validateJoinInput({ displayName: "あ".repeat(101) }), /100文字以内/);
});

test("管理者は、管理者の行・管理者への昇格・自分自身を変えられない（持ち主だけ）", () => {
  const owner = { role: "owner", userId: OWNER };
  const admin = { role: "admin", userId: "u2" };
  const member = { role: "member", userId: "u3" };
  const target = { user_id: "u9", role: "member" };
  assert.equal(canManageMember(owner, { user_id: "u2", role: "admin" }, { role: "member" }), true);
  assert.equal(canManageMember(admin, target, { status: "active" }), true);
  assert.equal(canManageMember(admin, target, { role: "admin" }), false);
  assert.equal(canManageMember(admin, { user_id: "u8", role: "admin" }, { status: "suspended" }), false);
  assert.equal(canManageMember(admin, { user_id: "u2", role: "admin" }), false);
  assert.equal(canManageMember(member, target), false);
});

test("画面へ返す形: 管理者の担当店舗は null（全店舗）。メールアドレスなどの最小限だけ", () => {
  const r = { id: "m1", user_id: "u3", email: "a@example.com", display_name: "渋谷店", role: "member", status: "pending", requested_at: "t", approved_at: null, updated_at: "t", owner_id: OWNER };
  assert.deepEqual(publicMember(r, [S1]), { id: "m1", userId: "u3", email: "a@example.com", displayName: "渋谷店", role: "member", roleLabel: "メンバー", status: "pending",
    requestedAt: "t", approvedAt: null, updatedAt: "t", storeIds: [S1] });
  assert.equal(publicMember({ ...r, role: "admin" }, [S1]).storeIds, null);
  const me = publicTeamMe(teamContext(user("u3"), OWNER, row({ status: "pending" })), { display_name: "渋谷店", requested_at: "t" });
  assert.equal(me.role, "pending");
  assert.equal(me.permissions.active, false);
  assert.equal(me.displayName, "渋谷店");
});

test("配線: review-api / ai-analyst は役割を確かめ、書き込みは持ち主の user_id。読み込みは本人のJWT（RLS）のまま", () => {
  const review = fs.readFileSync(new URL("../../supabase/functions/review-api/index.ts", import.meta.url), "utf8");
  assert.match(review, /if \(user && !can\.active && path !== "\/sources"\) return json\(req,\{error:NOT_MEMBER/);
  assert.match(review, /if \(!can\.manageCredentials\) return json\(req,\{error:FORBIDDEN\},403\)/);
  assert.match(review, /if \(!can\.manageStores\) return json\(req,\{error:FORBIDDEN\},403\)/);
  assert.match(review, /if \(!can\.manageTeam\) return json\(req,\{error:FORBIDDEN\},403\)/);
  assert.match(review, /!canUseSiteKey\(team,await ownerSites\(\),row\.source,row\.store_id\)\) return json\(req,\{error:NOT_YOUR_STORE\},403\)/);
  assert.match(review, /insert\(\{\.\.\.row,user_id:team\.ownerId,requested_by:user\.id\}\)/);
  // 承認・担当店舗の後でなく、書き込みに本人の user_id を使っていない（チームの行・依頼者・更新者を除く）
  const writes = review.split("\n").filter((l) => /user_id:user\.id|eq\("user_id",user\.id\)/.test(l));
  assert.deepEqual(writes, []);
  assert.match(review, /client\.from\("agent_requests"\)\.select\(requestColumns\)/, "依頼の閲覧は本人のJWT（RLS）");
  const ai = fs.readFileSync(new URL("../../supabase/functions/ai-analyst/index.ts", import.meta.url), "utf8");
  assert.match(ai, /if \(!can\.active\) return json\(req, \{ error:"参加の承認が必要です/);
  assert.match(ai, /!can\.shareMtalk\) return json\(req, \{ error:"M-talkへの送信は持ち主・管理者だけができます" \}, 403\)/);
  assert.ok(ai.indexOf("if (!can.active)") < ai.indexOf('if (path === "/ask"'), "AIの前に承認を確かめる");
  const sql = fs.readFileSync(new URL("../../supabase/migrations/024_team_members.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /drop policy if exists \w+_owner_(read|all)/, "持ち主の policy は変えない");
  assert.doesNotMatch(sql, /on public\.credentials/, "ログイン情報の表には policy を足さない");
  assert.match(sql, /grant select on public\.team_members, public\.team_member_stores to authenticated;/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)/i, "チームの表はブラウザから書けない");
});
