-- 取得依頼（agent_requests）の期限まわりの修正（2026-10-22 の食べログ取得が丸1日抜けた件）。
-- 1) released_at: 取得中（claimed）のまま30分を過ぎて queued に戻された時刻。「24時間拾われない依頼は失敗」の起点を
--    requested_at ではなく coalesce(released_at, requested_at) にする（取りかけで戻された依頼が、元の依頼時刻から24時間で即失敗しないように）。
--    自動で失敗にした行には failure_kind = 'other' も付ける。
-- 2) extend_agent_request: 長い取得の途中で claimed_at を今に更新して、30分の期限を延ばす（claim_id が一致する取得中の依頼だけ）。
-- 3) supersede_agent_request: 自動取得（enqueue-due）が、20時間以上前の古い未完了の依頼を「新しい依頼に置き換え」として失敗にする。
--    取得中は、最後の claim・延長から30分を過ぎたもの（作業中でないもの）だけ。
alter table public.agent_requests add column if not exists released_at timestamptz;
grant select (released_at) on public.agent_requests to authenticated;
comment on column public.agent_requests.released_at is '取得中のまま30分を過ぎて依頼中に戻された時刻（24時間の期限はこの時刻から数える）';

create or replace function public.claim_agent_requests(p_user uuid, p_agent text, p_limit integer default 1, p_source text default null, p_origin text default null)
returns setof public.agent_requests language plpgsql set search_path = '' as $$
begin
  if p_user is null then raise exception 'Invalid user'; end if;
  if p_origin is not null and p_origin not in ('app', 'schedule', 'mtalk_live') then raise exception 'Invalid origin'; end if;
  update public.agent_requests set status = 'failed', finished_at = now(), claim_id = null, failure_kind = 'other',
    error = case when status = 'queued' then '24時間以内に取得されませんでした。もう一度依頼してください' else '取得が完了しませんでした（3回）。管理画面の状態を確認してください' end
    where user_id = p_user and ((status = 'queued' and coalesce(released_at, requested_at) < now() - interval '24 hours')
      or (status = 'claimed' and claimed_at < now() - interval '30 minutes' and attempts >= 3));
  update public.agent_requests set status = 'queued', claimed_at = null, claimed_by = null, claim_id = null, released_at = now()
    where user_id = p_user and status = 'claimed' and claimed_at < now() - interval '30 minutes';
  return query
    with picked as (
      select q.id from public.agent_requests q
      where q.user_id = p_user and q.status = 'queued' and (p_source is null or q.source = p_source) and (p_origin is null or q.origin = p_origin)
      order by (q.origin = 'mtalk_live') desc, q.requested_at limit least(greatest(coalesce(p_limit, 1), 1), 20)
      for update skip locked
    )
    update public.agent_requests a set status = 'claimed', claimed_at = now(), claimed_by = left(coalesce(p_agent, ''), 100),
      claim_id = gen_random_uuid(), attempts = a.attempts + 1
    from picked where a.id = picked.id
    returning a.*;
end;
$$;
revoke all on function public.claim_agent_requests(uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.claim_agent_requests(uuid, text, integer, text, text) to service_role;

-- 取得中の期限の延長（ハートビート）。claimed_at を今にする。期限（30分）を過ぎて戻された・他で終了済みなら P0409
create or replace function public.extend_agent_request(p_user uuid, p_id uuid, p_claim uuid)
returns public.agent_requests language plpgsql set search_path = '' as $$
declare v public.agent_requests;
begin
  update public.agent_requests set claimed_at = now()
    where id = p_id and user_id = p_user and claim_id = p_claim and status = 'claimed'
    returning * into v;
  if found then return v; end if;
  raise exception 'Invalid claim' using errcode = 'P0409';
end;
$$;

-- 古い未完了の依頼を置き換えのため失敗にする（enqueue-due 専用）。失敗にできたら true
create or replace function public.supersede_agent_request(p_user uuid, p_id uuid, p_older_than interval default interval '20 hours')
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.agent_requests set status = 'failed', finished_at = now(), claim_id = null, failure_kind = 'other',
    error = '新しい自動取得の依頼に置き換えました（superseded）'
    where id = p_id and user_id = p_user and requested_at < now() - p_older_than
      and (status = 'queued' or (status = 'claimed' and claimed_at < now() - interval '30 minutes'));
  return found;
end;
$$;
revoke all on function public.extend_agent_request(uuid, uuid, uuid), public.supersede_agent_request(uuid, uuid, interval) from public, anon, authenticated;
grant execute on function public.extend_agent_request(uuid, uuid, uuid), public.supersede_agent_request(uuid, uuid, interval) to service_role;
