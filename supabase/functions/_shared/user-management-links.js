export const GLOBAL_USERS_URL = "https://marugo-s.github.io/multiapp/?admin=users";
export const GOURMET_USERS_URL = "https://marugo-s.github.io/gourmet/?view=users";
// Navigation intent only. Access still requires the current gourmet admin role.
export const isUserManagementLink = search => new URLSearchParams(search).get("view") === "users";
