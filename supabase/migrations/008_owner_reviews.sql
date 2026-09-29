-- Keep source identity, actual dates, full/excerpt distinction and individual ratings.
alter table public.reviews
  alter column rating drop not null, alter column rating drop default,
  alter column review_date drop not null,
  add column external_id text,
  add column title text not null default '',
  add column visit_month text,
  add column details jsonb not null default '{}'::jsonb,
  add constraint reviews_external_identity unique(user_id,source,external_id);
-- Existing SELECT grants/RLS remain unchanged; client writes remain forbidden.

-- The owner, lease, all writes, verification and final state stay in one transaction.
create or replace function public.finish_sync(p_job uuid, p_lease uuid, p_result jsonb, p_snapshots jsonb default '[]', p_reviews jsonb default '[]', p_reports jsonb default '[]')
returns void language plpgsql set search_path = '' as $$
declare j public.sync_jobs; r jsonb; saved public.snapshots; stored_review public.reviews; metric text;
begin
  select * into j from public.sync_jobs where id=p_job and lease_id=p_lease for update;
  if not found then raise exception 'Invalid lease'; end if;
  if j.status <> 'running' then return; end if;
  if j.lease_until is null or j.lease_until < now() then raise exception 'Lease expired'; end if;
  if coalesce(p_result->>'source','') <> 'tabelog' or coalesce(p_result->>'status','') not in ('ok','partial','error') then raise exception 'Invalid result'; end if;
  if p_result->>'status' in ('ok','partial') then
    if jsonb_typeof(p_snapshots) <> 'array' or (jsonb_array_length(p_snapshots)=0 and jsonb_array_length(p_reviews)=0) then raise exception 'Missing data'; end if;
    if p_result->>'status'='partial' and coalesce(p_result->>'warning','')='' then raise exception 'Missing partial warning'; end if;
    for r in select value from jsonb_array_elements(p_snapshots) loop
      insert into public.snapshots(user_id,source,date,rating,reviews,pv,visits,reservations)
      values(j.user_id,'tabelog',(r->>'date')::date,(r->>'rating')::numeric,(r->>'reviews')::int,(r->>'pv')::int,(r->>'visits')::int,(r->>'reservations')::int)
      on conflict(user_id,source,date) do update set
        rating=coalesce(excluded.rating,snapshots.rating), reviews=coalesce(excluded.reviews,snapshots.reviews),
        pv=coalesce(excluded.pv,snapshots.pv), visits=coalesce(excluded.visits,snapshots.visits), reservations=coalesce(excluded.reservations,snapshots.reservations)
      returning * into saved;
      foreach metric in array array['rating','reviews','pv','visits','reservations'] loop
        if r->>metric is not null and ((to_jsonb(saved)->>metric) is null or abs((to_jsonb(saved)->>metric)::numeric-(r->>metric)::numeric)>0.0001) then
          raise exception 'Saved metric mismatch: %', metric;
        end if;
      end loop;
    end loop;
    for r in select value from jsonb_array_elements(p_reviews) loop
      if r->>'external_id' is not null then
        if r->>'external_id' !~ '^B[0-9]+:([0-9]+|excerpt)$' then raise exception 'Invalid review identity'; end if;
        insert into public.reviews(user_id,source,external_id,title,rating,text,author,sentiment,review_date,visit_month,details)
        values(j.user_id,'tabelog',r->>'external_id',coalesce(r->>'title',''),(r->>'rating')::numeric,coalesce(r->>'text',''),coalesce(r->>'author','匿名'),'neutral',(r->>'review_date')::date,r->>'visit_month',coalesce(r->'details','{}'::jsonb))
        on conflict(user_id,source,external_id) do update set title=excluded.title,rating=excluded.rating,text=excluded.text,author=excluded.author,review_date=excluded.review_date,visit_month=excluded.visit_month,details=excluded.details
        returning * into stored_review;
        if stored_review.text is distinct from coalesce(r->>'text','')
          or stored_review.rating is distinct from (r->>'rating')::numeric
          or stored_review.review_date is distinct from (r->>'review_date')::date
          or stored_review.details is distinct from coalesce(r->'details','{}'::jsonb) then raise exception 'Saved review mismatch'; end if;
      elsif coalesce(r->>'text','') <> '' and not exists(select 1 from public.reviews where user_id=j.user_id and source='tabelog' and text=r->>'text') then
        insert into public.reviews(user_id,source,rating,text,author,sentiment,review_date)
        values(j.user_id,'tabelog',(r->>'rating')::numeric,r->>'text',coalesce(r->>'author','匿名'),'neutral',(r->>'review_date')::date);
      end if;
    end loop;
    for r in select value from jsonb_array_elements(p_reports) loop
      insert into public.source_reports(user_id,source,kind,period,data)
      values(j.user_id,'tabelog',r->>'kind',r->>'period',r->'data')
      on conflict(user_id,source,kind,period) do update set data=excluded.data,fetched_at=now();
    end loop;
  end if;
  insert into public.sync_log(user_id,source,status,message)
    values(j.user_id,'tabelog',p_result->>'status',coalesce(p_result->>'message',p_result->>'warning',''));
  update public.sync_jobs set status=case when p_result->>'status' in ('ok','partial') then 'completed' else 'error' end,
    step='finished', finished_at=now(), results=jsonb_build_array(p_result),
    message=case p_result->>'status'
      when 'ok' then '取得・保存が完了しました'
      when 'partial' then '一部取得：取得できた数値は保存済みです。未取得の項目をご確認ください'
      else '取得できませんでした。下の内容をご確認ください' end
  where id=j.id;
end;
$$;
revoke all on function public.finish_sync(uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.finish_sync(uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;
