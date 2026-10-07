import test from "node:test";
import assert from "node:assert/strict";
import { userManagement, viewingAccess } from "../../supabase/functions/_shared/user-management.js";
import { GLOBAL_USERS_URL, GOURMET_USERS_URL, isUserManagementLink } from "../../supabase/functions/_shared/user-management-links.js";

const USER = "3f2b8a4e-1111-4222-8333-944445555666";
const STORE = "3f2b8a4e-1111-4222-8333-944445555667";
const stub = result => ({ calls: [], async rpc(name, args) { this.calls.push([name, args]); return result; } });

test("management navigation has fixed destinations, no tokens or automatic role grants", () => {
  assert.equal(GLOBAL_USERS_URL, "https://marugo-s.github.io/multiapp/?admin=users");
  assert.equal(GOURMET_USERS_URL, "https://marugo-s.github.io/gourmet/?view=users");
  assert.equal(isUserManagementLink("?view=users"), true);
  assert.equal(isUserManagementLink("?view=accounts"), false);
  assert.equal(isUserManagementLink("?admin=true&redirect=https://evil.invalid"), false);
});

test("role and approval operations use the JWT client and preserve DB authorization failures", async () => {
  for (const [path, method, input, name] of [
    ["/users", "GET", null, "gourmet_list_users"],
    ["/users/admin", "POST", { userId: USER, enabled: true }, "gourmet_set_admin"],
    ["/users/access", "POST", { userId: USER, status: "approved", storeIds: [STORE] }, "gourmet_set_access"],
    ["/users/delete", "POST", { userId: USER, email: "test@example.com" }, "gourmet_delete_user"],
  ]) {
    const client = stub({ data: null, error: { code: "P0403", message: "管理者のみ" } });
    const r = await userManagement(client, path, method, input);
    assert.equal(r.status, 403); assert.equal(client.calls[0][0], name);
  }
});

test("malformed input never reaches privileged RPCs", async () => {
  for (const [path, method, input, page] of [
    ["/users", "GET", null, "0"], ["/users", "GET", null, "1.2"], ["/users", "GET", null, "100001"],
    ["/users/admin", "POST", { userId: USER, enabled: "true" }],
    ["/users/admin", "POST", { userId: "invalid", enabled: true }],
    ["/users/access", "POST", { userId: USER, status: "approved" }],
    ["/users/access", "POST", { userId: USER, status: "approved", storeIds: ["all"] }],
    ["/users/delete", "POST", { userId: USER }],
  ]) {
    const client = stub({ data: {}, error: null });
    assert.equal((await userManagement(client, path, method, input, page)).status, 400);
    assert.equal(client.calls.length, 0);
  }
});

test("store assignments are sent as exact UUIDs and arbitrary metadata cannot change roles", async () => {
  const client = stub({ data: { ok: true }, error: null });
  await userManagement(client, "/users/access", "POST", { userId: USER, status: "approved", storeIds: [STORE], isAdmin: true });
  assert.deepEqual(client.calls, [["gourmet_set_access", { p_target: USER, p_status: "approved", p_stores: [STORE] }]]);
  assert.equal((await userManagement(client, "/users/delete", "DELETE", {})).status, 404);
});

test("access checks fail closed for pending, revoked, null and DB failures", async () => {
  for (const data of [false, null, undefined, "true"]) assert.equal((await viewingAccess(stub({ data, error: null }))).status, 403);
  assert.equal(await viewingAccess(stub({ data: true, error: null })), null);
  const failed = await viewingAccess(stub({ data: true, error: { message: "secret db error" } }));
  assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed).includes("secret"), false);
});

test("safe validation/conflict errors are surfaced and database internals are hidden", async () => {
  for (const [code, status] of [["P0400", 400], ["P0404", 404], ["P0409", 409], ["42501", 500]]) {
    const r = await userManagement(stub({ error: { code, message: "internal" } }), "/users", "GET", null);
    assert.equal(r.status, status);
    if (status === 500) assert.equal(JSON.stringify(r).includes("internal"), false);
  }
});
