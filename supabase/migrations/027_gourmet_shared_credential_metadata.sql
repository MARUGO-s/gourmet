-- 管理者間で登録状態だけを共有する。010の列単位SELECT権限は変更しない。
-- username/password_enc は引き続き参照不可。所有者条件付きの書込も変更しない。
create policy gourmet_admin_metadata_read on public.credentials
  for select to authenticated
  using ((select public.gourmet_is_admin()));
