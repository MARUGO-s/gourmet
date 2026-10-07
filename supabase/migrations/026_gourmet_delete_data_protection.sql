-- Deletion must not cascade away orphaned metrics/reviews or operational settings.
create function public.gourmet_user_has_data(p_target uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare t text; owns_data boolean;
begin
  foreach t in array array['stores','credentials','snapshots','reviews','source_reports','sync_jobs','sync_log',
    'ikyu_stores','ikyu_daily_pageviews','ikyu_monthly_pageviews','ikyu_reviews','ikyu_ingest_runs',
    'source_stores','source_daily_metrics','source_monthly_metrics','source_reviews','agent_reports','agent_ingest_runs',
    'agent_requests','fetch_schedules','ai_reports','ai_usage','ai_report_shares','site_page_snapshots',
    'review_alert_settings','review_alert_events','review_alert_deliveries','weekly_delivery_schedules'] loop
    execute format('select exists(select 1 from public.%I where user_id=$1)',t) into owns_data using p_target;
    if owns_data then return true; end if;
  end loop;
  return exists(select 1 from public.mtalk_followups where owner_user_id=p_target)
    or exists(select 1 from public.mtalk_live_lookups where owner_user_id=p_target);
end $$;
revoke all on function public.gourmet_user_has_data(uuid) from public,anon,authenticated;

create or replace function public.gourmet_delete_user(p_target uuid, p_email text) returns jsonb
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
  if public.gourmet_user_has_data(p_target) then
    raise exception 'データを所有するユーザーは削除できません。閲覧停止を利用してください' using errcode = 'P0409';
  end if;
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
end $$;
revoke all on function public.gourmet_delete_user(uuid,text) from public,anon;
grant execute on function public.gourmet_delete_user(uuid,text) to authenticated;
