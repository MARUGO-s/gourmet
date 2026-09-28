-- Dispatch state has no credentials; authenticated owners may read it via RLS.
alter table public.sync_jobs
  add column dispatch_requested_at timestamptz,
  add column dispatch_status text check (dispatch_status in ('requesting','requested','failed','unconfigured'));
grant select(dispatch_status) on public.sync_jobs to authenticated;
alter table public.sync_jobs alter column message set default '依頼を受け付けました。取得用サーバーの起動を依頼しています';

-- One request per job per two minutes, serialized by UPDATE; owner is mandatory.
create function public.reserve_sync_dispatch(p_job uuid, p_user uuid) returns boolean
language plpgsql set search_path = '' as $$
begin
  update public.sync_jobs set dispatch_requested_at=now(), dispatch_status='requesting'
  where id=p_job and user_id=p_user and status='running' and step='queued' and lease_id is null
    and (dispatch_requested_at is null or dispatch_requested_at < now()-interval '2 minutes');
  return found;
end;
$$;
revoke all on function public.reserve_sync_dispatch(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_sync_dispatch(uuid,uuid) to service_role;

-- Bounded waiting. Do not expire an active lease based on time in the queue.
create or replace function public.expire_sync_jobs() returns void language sql set search_path = '' as $$
  update public.sync_jobs set status='error', step='timeout', finished_at=now(),
    message=case when lease_id is null
      then '20分以内に取得処理が開始されませんでした。起動設定を確認してから再同期してください。前回の保存値は保持されています'
      else '取得処理が時間内に完了しませんでした。前回の保存値は保持されています。再同期してください' end
  where status='running' and ((lease_until is not null and lease_until < now())
    or (lease_id is null and started_at < now()-interval '20 minutes'));
$$;
