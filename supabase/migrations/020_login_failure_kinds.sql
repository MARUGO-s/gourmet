-- 取得の失敗理由を機械で読める形にし、ログインの問題を M-talk・アプリから直せるようにする。
--
-- 1) agent_requests.failure_kind: 失敗の種類（needs_relogin = ID・パスワードが通らない・ログインが切れた /
--    needs_human_check = ログインで「私は人間です」の確認（チェックボックス・画像パズルなど）を求められた / other = それ以外）。
--    Grok Bot の --fail --kind で報告する。指定が無い報告（古い版）は agent-api が理由の文（「要再ログイン」など）から判定する。
--    ここでは既存の失敗も同じ規則で埋める。「ログイン情報を更新」のボタンは needs_relogin のときだけ出す。
-- 2) mtalk_followups: M-talk の「最新を調べる」で失敗したあと、アプリでログイン情報を更新して取り直した依頼。
--    取得が終わると agent-api が「再ログイン後の取得結果」をそのトークへ1回だけ送る。

alter table public.agent_requests add column if not exists failure_kind text;
alter table public.agent_requests drop constraint if exists agent_requests_failure_kind_check;
alter table public.agent_requests add constraint agent_requests_failure_kind_check
  check (failure_kind is null or failure_kind in ('needs_relogin', 'needs_human_check', 'other'));
-- 理由の文 → 種類（_shared/agent-requests.js の classifyFailure と同じ規則。「私は人間です」を先に見る）
create or replace function public.classify_agent_failure(p_error text) returns text language sql immutable set search_path = '' as $$
  select case
    when p_error ~* '(私は人間|人間です|ロボットではありません|画像認証|captcha|recaptcha|turnstile|human)' then 'needs_human_check'
    when p_error ~* '(再ログイン|ログイン(でき|に失敗|切れ|が必要)|パスワードが(通ら|違|誤)|ID・パスワード|login|session|password)' then 'needs_relogin'
    else 'other' end
$$;
revoke all on function public.classify_agent_failure(text) from public, anon, authenticated;
grant execute on function public.classify_agent_failure(text) to service_role;
-- 既存の失敗（理由の文だけ）も同じ規則で埋める
update public.agent_requests set failure_kind = public.classify_agent_failure(error) where status = 'failed' and failure_kind is null;
grant select (failure_kind) on public.agent_requests to authenticated;
comment on column public.agent_requests.failure_kind is '失敗の種類: needs_relogin（ログイン情報の更新が必要）/ needs_human_check（「私は人間です」の確認を求められた）/ other';

-- 完了・失敗の報告: p_failure_kind を足す（6引数版は消す。名前付きで6つ渡す既存の呼び出しはこの版がそのまま受け、種類は理由の文から決める）
drop function if exists public.finish_agent_request(uuid, uuid, uuid, text, jsonb, text);
create or replace function public.finish_agent_request(p_user uuid, p_id uuid, p_claim uuid, p_status text, p_result jsonb default null, p_error text default null, p_failure_kind text default null)
returns public.agent_requests language plpgsql set search_path = '' as $$
declare v public.agent_requests;
begin
  if p_status not in ('done','failed') then raise exception 'Invalid status'; end if;
  if p_failure_kind is not null and p_failure_kind not in ('needs_relogin', 'needs_human_check', 'other') then raise exception 'Invalid failure kind'; end if;
  update public.agent_requests set status = p_status, finished_at = now(), result = p_result, error = left(p_error, 1000),
      failure_kind = case when p_status = 'failed' then coalesce(p_failure_kind, public.classify_agent_failure(p_error)) else null end
    where id = p_id and user_id = p_user and claim_id = p_claim and status = 'claimed'
    returning * into v;
  if found then return v; end if;
  select * into v from public.agent_requests where id = p_id and user_id = p_user and claim_id = p_claim and status = p_status;
  if found then return v; end if;
  raise exception 'Invalid claim' using errcode = 'P0409';
end;
$$;

revoke all on function public.finish_agent_request(uuid, uuid, uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.finish_agent_request(uuid, uuid, uuid, text, jsonb, text, text) to service_role;

create table if not exists public.mtalk_followups (
  request_id uuid primary key references public.agent_requests(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  lookup_id uuid not null references public.mtalk_live_lookups(id) on delete cascade,
  -- relogin = アプリでログイン情報を更新したあとの取り直し
  kind text not null default 'relogin' check (kind in ('relogin')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sending_at timestamptz,
  sent_at timestamptz,
  error text check (length(error) <= 300)
);
create index if not exists mtalk_followups_open on public.mtalk_followups(owner_user_id, created_at) where status in ('pending', 'sending');
alter table public.mtalk_followups enable row level security;
revoke all on public.mtalk_followups from public, anon, authenticated;
grant select, insert, update on public.mtalk_followups to service_role;
comment on table public.mtalk_followups is 'M-talk「最新を調べる」の失敗後、アプリでログイン情報を更新して取り直した依頼。終わったら agent-api が「再ログイン後の取得結果」を1回だけ送る。service_role だけ。';
