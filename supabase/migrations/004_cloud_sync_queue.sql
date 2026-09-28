-- Only authenticated owners can read their data. Mutations go through authenticated Edge APIs.
revoke all on public.credentials, public.snapshots, public.reviews, public.sync_log, public.source_reports from anon, authenticated;
grant select (id, user_id, source, label, username, created_at, updated_at) on public.credentials to authenticated;
grant select on public.snapshots, public.reviews, public.sync_log, public.source_reports to authenticated;

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sources text[] not null default array['tabelog'],
  status text not null default 'running' check (status in ('running','completed','error')),
  step text not null default 'queued',
  message text not null default 'クラウドでの取得開始を待っています。通常は数分かかります',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  results jsonb not null default '[]'::jsonb
);
alter table public.sync_jobs enable row level security;
create policy sync_jobs_owner_read on public.sync_jobs for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.sync_jobs from anon, authenticated;
grant select(id,user_id,sources,status,step,message,started_at,finished_at,results) on public.sync_jobs to authenticated;
create unique index sync_jobs_one_active on public.sync_jobs(user_id) where status = 'running';
create index sync_jobs_queue on public.sync_jobs(started_at) where status = 'running';
create index sync_jobs_user_started on public.sync_jobs(user_id, started_at desc);

create function public.expire_sync_jobs() returns void language sql set search_path = '' as $$
  update public.sync_jobs set status='error', step='timeout', finished_at=now(),
    message='取得処理が時間内に完了しませんでした。しばらく待ってから再同期してください'
  where status='running' and ((lease_until is not null and lease_until < now()) or started_at < now() - interval '24 hours');
$$;

create function public.enqueue_sync(p_user uuid) returns public.sync_jobs
language plpgsql set search_path = '' as $$
declare j public.sync_jobs;
begin
  perform 1 from auth.users where id=p_user for update;
  if not found then raise exception 'Unknown user'; end if;
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

create function public.claim_sync() returns public.sync_jobs
language plpgsql set search_path = '' as $$
declare j public.sync_jobs;
begin
  perform public.expire_sync_jobs();
  select * into j from public.sync_jobs where status='running' and lease_id is null order by started_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.sync_jobs set lease_id=gen_random_uuid(), lease_until=now()+interval '10 minutes', step='starting', message='クラウドで取得を開始しています'
    where id=j.id returning * into j;
  return j;
end;
$$;

-- Validate in Edge first; keep the complete write and job completion in one transaction.
-- Missing fields in partial snapshots retain the previously saved values.
create function public.finish_sync(p_job uuid, p_lease uuid, p_result jsonb, p_snapshots jsonb default '[]', p_reviews jsonb default '[]', p_reports jsonb default '[]')
returns void language plpgsql set search_path = '' as $$
declare j public.sync_jobs; r jsonb; saved_rating numeric;
begin
  select * into j from public.sync_jobs where id=p_job and lease_id=p_lease for update;
  if not found then raise exception 'Invalid lease'; end if;
  if j.status <> 'running' then return; end if;
  if j.lease_until < now() then raise exception 'Lease expired'; end if;
  if p_result->>'source' <> 'tabelog' or p_result->>'status' not in ('ok','error') then raise exception 'Invalid result'; end if;
  if p_result->>'status' = 'ok' then
    if jsonb_array_length(p_snapshots)=0 then raise exception 'Missing snapshots'; end if;
    for r in select value from jsonb_array_elements(p_snapshots) loop
      insert into public.snapshots(user_id,source,date,rating,reviews,pv,visits,reservations)
      values(j.user_id,'tabelog',(r->>'date')::date,coalesce((r->>'rating')::numeric,0),coalesce((r->>'reviews')::int,0),coalesce((r->>'pv')::int,0),coalesce((r->>'visits')::int,0),coalesce((r->>'reservations')::int,0))
      on conflict(user_id,source,date) do update set
        rating=coalesce((r->>'rating')::numeric,snapshots.rating), reviews=coalesce((r->>'reviews')::int,snapshots.reviews),
        pv=coalesce((r->>'pv')::int,snapshots.pv), visits=coalesce((r->>'visits')::int,snapshots.visits), reservations=coalesce((r->>'reservations')::int,snapshots.reservations)
      returning rating into saved_rating;
      if r ? 'rating' and abs(saved_rating-(r->>'rating')::numeric)>0.0001 then raise exception 'Rating precision mismatch'; end if;
    end loop;
    for r in select value from jsonb_array_elements(p_reviews) loop
      if coalesce(r->>'text','') <> '' and not exists(select 1 from public.reviews where user_id=j.user_id and source='tabelog' and text=r->>'text') then
        insert into public.reviews(user_id,source,rating,text,author,sentiment,review_date)
        values(j.user_id,'tabelog',coalesce((r->>'rating')::numeric,0),r->>'text',coalesce(r->>'author','匿名'),'neutral',(now() at time zone 'Asia/Tokyo')::date);
      end if;
    end loop;
    for r in select value from jsonb_array_elements(p_reports) loop
      insert into public.source_reports(user_id,source,kind,period,data)
      values(j.user_id,'tabelog',r->>'kind',r->>'period',r->'data')
      on conflict(user_id,source,kind,period) do update set data=excluded.data,fetched_at=now();
    end loop;
  end if;
  insert into public.sync_log(user_id,source,status,message) values(j.user_id,'tabelog',p_result->>'status',coalesce(p_result->>'message',''));
  update public.sync_jobs set status=case when p_result->>'status'='ok' then 'completed' else 'error' end,
    step='finished', finished_at=now(), results=jsonb_build_array(p_result),
    message=case when p_result->>'status'='ok' then '取得・保存が完了しました' else '取得できませんでした。下の内容をご確認ください' end
  where id=j.id;
end;
$$;

revoke all on function public.expire_sync_jobs(), public.enqueue_sync(uuid), public.claim_sync(), public.finish_sync(uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.expire_sync_jobs(), public.enqueue_sync(uuid), public.claim_sync(), public.finish_sync(uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;
