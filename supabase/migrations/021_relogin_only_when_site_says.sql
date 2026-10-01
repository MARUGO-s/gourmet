-- needs_relogin（「ログイン情報を更新」のボタン）は、サイトの画面が ID・パスワードが違うとはっきり表示したときだけにする。
--   「要再ログイン」「401」「認証エラー」「ログイン画面に戻された」だけの失敗は other。2段階認証のコード・Cloudflare の確認は needs_human_check。
--   _shared/agent-requests.js の classifyFailure / acceptedFailureKind と同じ規則。
create or replace function public.classify_agent_failure(p_error text) returns text language sql immutable set search_path = '' as $$
  select case
    when p_error ~* '(私は人間|人間です|ロボットではありません|画像認証|captcha|recaptcha|turnstile|verify you are human|cloudflare|human|二段階|2段階|２段階|認証コード|確認コード|ワンタイム)' then 'needs_human_check'
    when p_error ~* '(正しくありません|誤りがあります|間違っています|一致しません|incorrect|wrong password|invalid (id|user|password|credential))' then 'needs_relogin'
    else 'other' end
$$;
revoke all on function public.classify_agent_failure(text) from public, anon, authenticated;
grant execute on function public.classify_agent_failure(text) to service_role;

-- 完了・失敗の報告: needs_relogin は理由の文にサイトの表示が無ければ文から判定し直す（agent-api の acceptedFailureKind と同じ。念のため DB でも）
create or replace function public.finish_agent_request(p_user uuid, p_id uuid, p_claim uuid, p_status text, p_result jsonb default null, p_error text default null, p_failure_kind text default null)
returns public.agent_requests language plpgsql set search_path = '' as $$
declare v public.agent_requests;
declare k text;
begin
  if p_status not in ('done','failed') then raise exception 'Invalid status'; end if;
  if p_failure_kind is not null and p_failure_kind not in ('needs_relogin', 'needs_human_check', 'other') then raise exception 'Invalid failure kind'; end if;
  k := case when p_failure_kind is null then public.classify_agent_failure(p_error)
            when p_failure_kind = 'needs_relogin' and public.classify_agent_failure(p_error) <> 'needs_relogin' then public.classify_agent_failure(p_error)
            else p_failure_kind end;
  update public.agent_requests set status = p_status, finished_at = now(), result = p_result, error = left(p_error, 1000),
      failure_kind = case when p_status = 'failed' then k else null end
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

-- 既存の needs_relogin を同じ規則で直す（サイトの表示が理由に無いもの → other / needs_human_check）。
--   2026-10-01 時点の本番では一休 112789 の 6ee3717a・892de434・6fed4391・a9f5c78b・a5570229（いずれも「要再ログイン」だけ）が other になる。
--   a165f4ab はすでに other。needs_human_check・other の行には触れない。
update public.agent_requests set failure_kind = public.classify_agent_failure(error)
  where status = 'failed' and failure_kind = 'needs_relogin' and public.classify_agent_failure(error) <> 'needs_relogin';
