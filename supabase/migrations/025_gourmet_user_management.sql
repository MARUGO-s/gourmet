-- 025: Review Command 専用の管理者。SNS側のロールとは独立して管理する。
-- 024は未マージのチーム共有案で使用されているため予約。両案の同時適用は不可。
create table public.gourmet_admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);
alter table public.gourmet_admin_users enable row level security;
revoke all on public.gourmet_admin_users from anon, authenticated;
grant all on public.gourmet_admin_users to service_role;

create table public.gourmet_role_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  target_user_id uuid references auth.users(id) on delete set null,
  enabled boolean not null,
  kind text not null default 'admin' check (kind in ('admin', 'access', 'delete')),
  access_status text,
  target_email text,
  store_ids uuid[],
  changed_at timestamptz not null default now()
);
alter table public.gourmet_role_audit enable row level security;
revoke all on public.gourmet_role_audit from anon, authenticated;
grant all on public.gourmet_role_audit to service_role;

create table public.gourmet_user_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null check (status in ('approved', 'revoked')),
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);
alter table public.gourmet_user_access enable row level security;
revoke all on public.gourmet_user_access from anon, authenticated;
grant all on public.gourmet_user_access to service_role;

create table public.gourmet_store_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  primary key(user_id, store_id)
);
alter table public.gourmet_store_access enable row level security;
revoke all on public.gourmet_store_access from anon, authenticated;
grant all on public.gourmet_store_access to service_role;

create function public.gourmet_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.gourmet_admin_users where user_id = (select auth.uid()));
$$;
revoke all on function public.gourmet_is_admin() from public, anon;
grant execute on function public.gourmet_is_admin() to authenticated;

-- 未登録のアクセス設定は必ずpending（承認待ち）。利用者が自分で変更できる情報は参照しない。
create function public.gourmet_can_view() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.gourmet_is_admin() or (
    exists(select 1 from public.gourmet_user_access where user_id = (select auth.uid()) and status = 'approved')
    and exists(select 1 from public.gourmet_store_access where user_id = (select auth.uid()))
  );
$$;
revoke all on function public.gourmet_can_view() from public, anon;
grant execute on function public.gourmet_can_view() to authenticated;

create function public.gourmet_my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('isAdmin', public.gourmet_is_admin(), 'canView', public.gourmet_can_view(),
    'revision', coalesce((select changed_at::text from public.gourmet_user_access where user_id = (select auth.uid())), '') ||
      coalesce((select granted_at::text from public.gourmet_admin_users where user_id = (select auth.uid())), ''),
    'status', case when public.gourmet_is_admin() then 'approved'
      else coalesce((select status from public.gourmet_user_access where user_id = (select auth.uid())), 'pending') end);
$$;
revoke all on function public.gourmet_my_access() from public, anon;
grant execute on function public.gourmet_my_access() to authenticated;

create function public.gourmet_list_users(p_page integer default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.gourmet_is_admin() then
    raise exception 'ユーザー管理は管理者のみ利用できます' using errcode = 'P0403';
  end if;
  if p_page is null or p_page < 1 or p_page > 100000 then
    raise exception 'ページの指定が不正です' using errcode = 'P0400';
  end if;
  select jsonb_build_object('total', (select count(*) from auth.users), 'page', p_page,
    'users', coalesce(jsonb_agg(row_data order by created_at, id), '[]'::jsonb)) into result
  from (
    select u.created_at, u.id, jsonb_build_object(
      'id', u.id, 'email', coalesce(u.email, ''), 'createdAt', u.created_at,
      'lastSignInAt', u.last_sign_in_at, 'confirmed', u.email_confirmed_at is not null,
      'isAdmin', a.user_id is not null, 'grantedAt', a.granted_at,
      'accessStatus', case when a.user_id is not null then 'approved' else coalesce(v.status, 'pending') end,
      'storeCount', (select count(*) from public.stores s where s.user_id = u.id),
      'storeIds', coalesce((select jsonb_agg(v.store_id) from public.gourmet_store_access v where v.user_id = u.id), '[]'::jsonb),
      'deletable', not exists(select 1 from public.gourmet_admin_users x where x.user_id=u.id)
        and not exists(select 1 from public.stores s where s.user_id=u.id)
    ) as row_data
    from auth.users u left join public.gourmet_admin_users a on a.user_id = u.id
    left join public.gourmet_user_access v on v.user_id = u.id
    order by u.created_at, u.id limit 100 offset ((p_page - 1) * 100)
  ) entries;
  return result || jsonb_build_object('stores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.sort_order, s.name) from public.stores s), '[]'::jsonb));
end;
$$;
revoke all on function public.gourmet_list_users(integer) from public, anon;
grant execute on function public.gourmet_list_users(integer) to authenticated;

create function public.gourmet_set_admin(p_target uuid, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); current_admin boolean;
begin
  -- 同時解除と、解除済み管理者による任命を同じロック下で防ぐ。
  perform pg_advisory_xact_lock(712024, 1);
  if not public.gourmet_is_admin() then
    raise exception 'ユーザー管理は管理者のみ利用できます' using errcode = 'P0403';
  end if;
  if p_enabled is null or p_target is null then
    raise exception 'ユーザーと権限を指定してください' using errcode = 'P0400';
  end if;
  perform 1 from auth.users where id = p_target for key share;
  if not found then
    raise exception 'ユーザーが見つかりません' using errcode = 'P0404';
  end if;
  select exists(select 1 from public.gourmet_admin_users where user_id = p_target) into current_admin;
  if p_enabled and not exists(select 1 from auth.users where id = p_target and email_confirmed_at is not null) then
    raise exception 'メール確認済みのユーザーだけ管理者に任命できます' using errcode = 'P0409';
  end if;
  if not p_enabled and current_admin then
    if (select count(*) from public.gourmet_admin_users) <= 1 then
      raise exception '最後の管理者は解除できません' using errcode = 'P0409';
    end if;
    if p_target = actor then
      raise exception '自分自身の管理者権限は解除できません' using errcode = 'P0409';
    end if;
  end if;
  if p_enabled is distinct from current_admin then
    if p_enabled then
      insert into public.gourmet_admin_users(user_id, granted_by) values(p_target, actor);
      insert into public.gourmet_user_access(user_id, status, changed_by) values(p_target, 'approved', actor)
        on conflict(user_id) do update set status = 'approved', changed_by = actor, changed_at = now();
    else
      delete from public.gourmet_admin_users where user_id = p_target;
      if not exists(select 1 from public.gourmet_store_access where user_id = p_target) then
        update public.gourmet_user_access set status = 'revoked', changed_by = actor, changed_at = now() where user_id = p_target;
      end if;
    end if;
    insert into public.gourmet_role_audit(actor_user_id, target_user_id, enabled) values(actor, p_target, p_enabled);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.gourmet_set_admin(uuid, boolean) from public, anon;
grant execute on function public.gourmet_set_admin(uuid, boolean) to authenticated;

create function public.gourmet_set_access(p_target uuid, p_status text, p_stores uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  perform pg_advisory_xact_lock(712024, 1);
  if not public.gourmet_is_admin() then
    raise exception 'ユーザー管理は管理者のみ利用できます' using errcode = 'P0403';
  end if;
  if p_target is null or p_status is null or p_status not in ('approved', 'revoked') then
    raise exception 'ユーザーと閲覧権限の指定が不正です' using errcode = 'P0400';
  end if;
  perform 1 from auth.users where id = p_target for key share;
  if not found then
    raise exception 'ユーザーが見つかりません' using errcode = 'P0404';
  end if;
  if p_status = 'revoked' and exists(select 1 from public.gourmet_admin_users where user_id = p_target) then
    raise exception '管理者の閲覧を停止するには、先に管理者権限を解除してください' using errcode = 'P0409';
  end if;
  if p_status = 'approved' and (p_stores is null or cardinality(p_stores) < 1 or cardinality(p_stores) > 200
    or exists(select 1 from unnest(p_stores) requested(id) where id is null or not exists(select 1 from public.stores s where s.id = requested.id))) then
    raise exception '閲覧を許可する店舗を1つ以上選択してください' using errcode = 'P0400';
  end if;
  if p_status = 'approved' and not exists(select 1 from auth.users where id = p_target and email_confirmed_at is not null) then
    raise exception 'メール確認済みのユーザーだけ承認できます' using errcode = 'P0409';
  end if;
  insert into public.gourmet_user_access(user_id, status, changed_by) values(p_target, p_status, actor)
    on conflict(user_id) do update set status = p_status, changed_by = actor, changed_at = now();
  insert into public.gourmet_role_audit(actor_user_id, target_user_id, enabled, kind, access_status, store_ids)
    values(actor, p_target, p_status = 'approved', 'access', p_status, case when p_status = 'approved' then p_stores else '{}'::uuid[] end);
  -- 店舗の変更も同じトランザクションで反映し、停止中の割り当ては消す。
  delete from public.gourmet_store_access where user_id = p_target;
  if p_status = 'approved' then
    insert into public.gourmet_store_access(user_id, store_id) select p_target, id from unnest(p_stores) requested(id) on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.gourmet_set_access(uuid, text, uuid[]) from public, anon;
grant execute on function public.gourmet_set_access(uuid, text, uuid[]) to authenticated;

create function public.gourmet_store_allowed(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.gourmet_is_admin() or (public.gourmet_can_view() and exists(
    select 1 from public.gourmet_store_access where user_id = (select auth.uid()) and store_id = p_store));
$$;
create function public.gourmet_site_allowed(p_owner uuid, p_source text, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.gourmet_is_admin() or (public.gourmet_can_view() and exists(
    select 1 from public.gourmet_store_access a join public.store_sites s on s.store_id = a.store_id
    where a.user_id = (select auth.uid()) and s.user_id = p_owner and s.source = p_source and s.site_store_key = p_key));
$$;
revoke all on function public.gourmet_store_allowed(uuid), public.gourmet_site_allowed(uuid,text,text) from public, anon;
grant execute on function public.gourmet_store_allowed(uuid), public.gourmet_site_allowed(uuid,text,text) to authenticated;

-- 既存の所有者条件を維持し、明示的な店舗割り当てによるSELECTを追加する。
-- 設定・旧全店舗集計・保存レポートは管理者だけ。店舗境界がある行だけ一般ユーザーへ公開する。
do $$
declare t text;
begin
  foreach t in array array['credentials','snapshots','reviews','sync_log','source_reports','sync_jobs',
    'credential_access_log','ikyu_stores','ikyu_daily_pageviews','ikyu_monthly_pageviews','ikyu_reviews','ikyu_ingest_runs',
    'source_stores','source_daily_metrics','source_monthly_metrics','source_reviews','agent_reports','agent_ingest_runs',
    'agent_requests','fetch_schedules','stores','store_sites','ai_reports','ai_usage','ai_report_shares',
    'review_alert_settings','review_alert_events','review_alert_deliveries','weekly_delivery_schedules'] loop
    execute format('create policy gourmet_approved_access on public.%I as restrictive for all to authenticated using ((select public.gourmet_is_admin())) with check ((select public.gourmet_is_admin()))', t);
  end loop;
  foreach t in array array['stores','store_sites','source_stores','source_daily_metrics','source_monthly_metrics','source_reviews','agent_reports',
    'ikyu_stores','ikyu_daily_pageviews','ikyu_monthly_pageviews','ikyu_reviews'] loop
    execute format('drop policy gourmet_approved_access on public.%I', t);
    execute format('create policy gourmet_approved_access on public.%I as restrictive for all to authenticated using ((select public.gourmet_can_view())) with check ((select public.gourmet_is_admin()))', t);
    execute format('create policy gourmet_admin_update on public.%I as restrictive for update to authenticated using ((select public.gourmet_is_admin()))', t);
    execute format('create policy gourmet_admin_delete on public.%I as restrictive for delete to authenticated using ((select public.gourmet_is_admin()))', t);
    if t = 'stores' then
      execute 'create policy gourmet_assigned_read on public.stores for select to authenticated using (public.gourmet_store_allowed(id))';
      execute 'create policy gourmet_store_scope on public.stores as restrictive for select to authenticated using (public.gourmet_store_allowed(id))';
    elsif t = 'store_sites' then
      execute 'create policy gourmet_assigned_read on public.store_sites for select to authenticated using (public.gourmet_store_allowed(store_id))';
      execute 'create policy gourmet_store_scope on public.store_sites as restrictive for select to authenticated using (public.gourmet_store_allowed(store_id))';
    elsif t like 'ikyu_%' then
      execute format('create policy gourmet_assigned_read on public.%I for select to authenticated using (public.gourmet_site_allowed(user_id,''ikyu'',store_id))', t);
      execute format('create policy gourmet_store_scope on public.%I as restrictive for select to authenticated using (public.gourmet_site_allowed(user_id,''ikyu'',store_id))', t);
    else
      execute format('create policy gourmet_assigned_read on public.%I for select to authenticated using (public.gourmet_site_allowed(user_id,source,store_key))', t);
      execute format('create policy gourmet_store_scope on public.%I as restrictive for select to authenticated using (public.gourmet_site_allowed(user_id,source,store_key))', t);
    end if;
  end loop;
end;
$$;

-- 削除は管理者の再検証と同じロック下で実行する。データ所有者は完全削除しない。
create function public.gourmet_delete_user(p_target uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); target_email text; owns_other boolean := false;
begin
  perform pg_advisory_xact_lock(712024, 1);
  if not public.gourmet_is_admin() then
    raise exception 'ユーザー管理は管理者のみ利用できます' using errcode = 'P0403';
  end if;
  select email into target_email from auth.users where id = p_target for update;
  if not found then raise exception 'ユーザーが見つかりません' using errcode = 'P0404'; end if;
  if p_email is null or p_email <> target_email then
    raise exception '確認用のメールアドレスが一致しません' using errcode = 'P0400';
  end if;
  if p_target = actor or exists(select 1 from public.gourmet_admin_users where user_id = p_target) then
    raise exception '管理者は削除できません。先に別の管理者が権限を解除してください' using errcode = 'P0409';
  end if;
  if exists(select 1 from public.stores where user_id = p_target)
    or exists(select 1 from public.credentials where user_id = p_target)
    or exists(select 1 from public.source_stores where user_id = p_target)
    or exists(select 1 from public.ikyu_stores where user_id = p_target)
    or exists(select 1 from public.ai_reports where user_id = p_target)
    or exists(select 1 from public.snapshots where user_id = p_target)
    or exists(select 1 from public.reviews where user_id = p_target)
    or exists(select 1 from public.source_reports where user_id = p_target)
    or exists(select 1 from public.source_daily_metrics where user_id = p_target)
    or exists(select 1 from public.source_monthly_metrics where user_id = p_target) then
    raise exception 'データを所有するユーザーは削除できません。閲覧停止を利用してください' using errcode = 'P0409';
  end if;
  -- 同じAuthを利用する別アプリの所有データも保護する（別アプリが無い環境でも動く）。
  if to_regclass('public.social_workspaces') is not null then
    execute 'select exists(select 1 from public.social_workspaces where created_by = $1)' into owns_other using p_target;
  end if;
  if to_regclass('public.social_admin_users') is not null then
    execute 'select $1 or exists(select 1 from public.social_admin_users where user_id = $2)' into owns_other using owns_other, p_target;
  end if;
  if owns_other then raise exception '他アプリの管理者・データ所有者は削除できません。閲覧停止を利用してください' using errcode = 'P0409'; end if;
  insert into public.gourmet_role_audit(actor_user_id, target_user_id, target_email, enabled, kind)
    values(actor, p_target, target_email, false, 'delete');
  delete from auth.users where id = p_target;
  return jsonb_build_object('ok', true);
exception when foreign_key_violation then
  raise exception '関連データがあるため削除できません。閲覧停止を利用してください' using errcode = 'P0409';
end;
$$;
revoke all on function public.gourmet_delete_user(uuid,text) from public, anon;
grant execute on function public.gourmet_delete_user(uuid,text) to authenticated;
