-- 028: 承認済みの一般ユーザーにも、割り当て店舗のグルメサイトアカウント登録を許可する。
-- ログインID・パスワードは引き続き review-api / agent-api 経由だけで扱い、RLSは登録済みメタデータの店舗境界を守る。

drop policy if exists gourmet_approved_access on public.credentials;
create policy gourmet_approved_access on public.credentials
  as restrictive for select to authenticated
  using ((select public.gourmet_can_view()));

drop policy if exists gourmet_assigned_read on public.credentials;
create policy gourmet_assigned_read on public.credentials
  for select to authenticated
  using (public.gourmet_site_allowed(user_id, source, store_key));

drop policy if exists gourmet_store_scope on public.credentials;
create policy gourmet_store_scope on public.credentials
  as restrictive for select to authenticated
  using (public.gourmet_site_allowed(user_id, source, store_key));

