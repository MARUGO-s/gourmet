-- M-talk「AI分析」Bot の1対1で、質問ごとに「1) サイトにログインして最新を調べる / 2) 今あるデータですぐ答える」を選べるようにする。
--
-- 1) agent_requests.origin: 依頼の出どころ（app = アプリの「今すぐ取得」、schedule = 自動取得の設定、mtalk_live = M-talk からの「最新を調べる」）。
--    Grok Bot は日本時間 9:00〜22:59 はすべての依頼を、それ以外の時間は origin = 'mtalk_live' だけを処理する
--    （claim_agent_requests の p_origin）。mtalk_live は他の依頼より先に取得する。
-- 2) mtalk_live_lookups: 選択待ちの質問（30分で期限切れ、同じトークの新しい質問で置き換え）と、「1」を選んだあとの取得・回答の状態。
--    読み書きは ai-analyst（/mtalk-chat）と agent-api（取得完了後の回答）の service_role だけ。ブラウザからは見えない。

alter table public.agent_requests add column if not exists origin text not null default 'app';
alter table public.agent_requests drop constraint if exists agent_requests_origin_check;
alter table public.agent_requests add constraint agent_requests_origin_check check (origin in ('app', 'schedule', 'mtalk_live'));
-- 既存の自動取得の依頼（params.trigger = 'schedule'）は schedule にする
update public.agent_requests set origin = 'schedule' where origin = 'app' and params->>'trigger' = 'schedule';
create index if not exists agent_requests_mtalk_live_queue on public.agent_requests(user_id, requested_at) where status = 'queued' and origin = 'mtalk_live';
-- ブラウザは origin を読めるだけ（登録できる列は 011 のまま: store_id, source, action, params → origin は既定の app）
grant select (origin) on public.agent_requests to authenticated;
comment on column public.agent_requests.origin is 'app = アプリの今すぐ取得 / schedule = 自動取得の設定 / mtalk_live = M-talk の「最新を調べる」（24時間処理・優先）';

-- 取得開始: p_origin を足す（同じ名前の4引数版は消す。名前付きで4つ渡す既存の呼び出しはこの版がそのまま受ける）。
drop function if exists public.claim_agent_requests(uuid, text, integer, text);
create or replace function public.claim_agent_requests(p_user uuid, p_agent text, p_limit integer default 1, p_source text default null, p_origin text default null)
returns setof public.agent_requests language plpgsql set search_path = '' as $$
begin
  if p_user is null then raise exception 'Invalid user'; end if;
  if p_origin is not null and p_origin not in ('app', 'schedule', 'mtalk_live') then raise exception 'Invalid origin'; end if;
  update public.agent_requests set status = 'failed', finished_at = now(), claim_id = null,
    error = case when status = 'queued' then '24時間以内に取得されませんでした。もう一度依頼してください' else '取得が完了しませんでした（3回）。管理画面の状態を確認してください' end
    where user_id = p_user and ((status = 'queued' and requested_at < now() - interval '24 hours')
      or (status = 'claimed' and claimed_at < now() - interval '30 minutes' and attempts >= 3));
  update public.agent_requests set status = 'queued', claimed_at = null, claimed_by = null, claim_id = null
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

create table if not exists public.mtalk_live_lookups (
  id uuid primary key default gen_random_uuid(),
  -- データの持ち主（gourmet の利用者。取得依頼もこの利用者で登録する）
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  mtalk_user_id uuid not null,
  mtalk_group_id bigint not null check (mtalk_group_id > 0),
  message_id bigint not null check (message_id > 0),
  question text not null check (length(question) between 1 and 2000),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array' and length(history::text) <= 60000),
  -- awaiting_choice → (1) fetching → answering → answered / failed / timed_out、(2) answered。
  -- 新しい質問で replaced、30分選ばれなければ expired
  status text not null default 'awaiting_choice'
    check (status in ('awaiting_choice', 'fetching', 'answering', 'answered', 'failed', 'timed_out', 'replaced', 'expired')),
  choice smallint check (choice in (1, 2)),
  -- 取得する店舗×サイト [{source, storeId, storeName}] と、その依頼（agent_requests.id）
  targets jsonb not null default '[]'::jsonb check (jsonb_typeof(targets) = 'array' and length(targets::text) <= 4000),
  request_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  chosen_at timestamptz,
  deadline_at timestamptz,
  answering_at timestamptz,
  finished_at timestamptz,
  attempts integer not null default 0,
  error text check (length(error) <= 1000)
);
-- 1つのトークで進行中（選択待ち・取得中・回答中）は1件だけ
create unique index if not exists mtalk_live_lookups_one_active on public.mtalk_live_lookups(mtalk_user_id, mtalk_group_id)
  where status in ('awaiting_choice', 'fetching', 'answering');
create index if not exists mtalk_live_lookups_room on public.mtalk_live_lookups(mtalk_user_id, mtalk_group_id, created_at desc);
create index if not exists mtalk_live_lookups_open on public.mtalk_live_lookups(owner_user_id, chosen_at) where status in ('fetching', 'answering');
alter table public.mtalk_live_lookups enable row level security;
revoke all on public.mtalk_live_lookups from anon, authenticated;
grant select, insert, update on public.mtalk_live_lookups to service_role;
comment on table public.mtalk_live_lookups is 'M-talk「AI分析」の1対1: 選択待ちの質問と「最新を調べる」の進み具合。service_role（ai-analyst / agent-api）だけが読み書きする。';
