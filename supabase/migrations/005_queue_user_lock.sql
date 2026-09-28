-- service_role intentionally has no direct access to auth.users.
-- Serialize enqueue requests using a transaction-scoped advisory lock instead.
create or replace function public.enqueue_sync(p_user uuid) returns public.sync_jobs
language plpgsql set search_path = '' as $$
declare j public.sync_jobs;
begin
  if p_user is null then raise exception 'Unknown user'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
  perform public.expire_sync_jobs();
  select * into j from public.sync_jobs where user_id=p_user and status='running';
  if found then return j; end if;
  if not exists(select 1 from public.credentials where user_id=p_user and source='tabelog') then
    raise exception '食べログのアカウントを登録してください';
  end if;
  if (select count(*) from public.sync_jobs where user_id=p_user and started_at > now()-interval '1 hour') >= 4 then
    raise exception '同期は1時間に4回までです。しばらく待ってからお試しください';
  end if;
  insert into public.sync_jobs(user_id) values(p_user) returning * into j;
  return j;
end;
$$;
revoke all on function public.enqueue_sync(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_sync(uuid) to service_role;
