-- 011: すべてのサイトを外部エージェント（Grok Bot）による取り込みへ移行し、アプリ → Grok Bot の取得依頼キューを追加する。
-- アプリ（ブラウザ・Edge Functions・GitHub Actions）はどのサイトにもログイン・取得しない。
-- 010 の後に適用し、直後に review-api / review-worker / agent-api を配置する（README「本番化の手順」）。
-- 既存の snapshots / reviews / source_reports / sync_log / sync_jobs の行は変更・削除しない（旧データは引き続き表示）。
-- PR #11 の一休公開評価（snapshots source='ikyu'）・公開口コミ（reviews source='ikyu'）もそのまま表示し、以後は agent-api の一休取り込み（stores[].public）で更新する。

-- ========== 1) アプリ内取得（sync_jobs + GitHub Actions）の停止 ==========
-- 処理中の依頼を終了扱いにし、キュー操作の関数を実行不可にする（関数と履歴は残す。再有効化は GRANT で可能）。
update public.sync_jobs set status = 'error', step = 'retired', finished_at = now(), lease_id = null, lease_until = null,
  message = 'アプリ内の自動取得は終了しました。データはGrok Botが取り込みます（「取得依頼」から依頼できます）'
  where status = 'running';
-- 009_ikyu_public_sync で enqueue_sync(uuid) は enqueue_sync(uuid,text) に置き換わっている。存在する版だけを対象にする
-- （001〜009 の適用状況が環境ごとに異なっても失敗しない）。
do $$
declare f text;
begin
  foreach f in array array['public.enqueue_sync(uuid)', 'public.enqueue_sync(uuid,text)', 'public.claim_sync()', 'public.expire_sync_jobs()',
    'public.finish_sync(uuid,uuid,jsonb,jsonb,jsonb,jsonb)', 'public.reserve_sync_dispatch(uuid,uuid)'] loop
    if pg_catalog.to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    end if;
  end loop;
end;
$$;

-- ========== 2) 全サイト共通の取り込みデータ（店舗×サイト） ==========
-- store_key: 各サイトの店舗コード（credentials.store_key と同じ値を推奨。''=既定の1店舗）。一休は ikyu_* 表を使う。
create table if not exists public.source_stores (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('tabelog','hotpepper','google','toreta','retty')),
  store_key text not null check (store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  name text,
  rating numeric(4,2) check (rating between 0 and 5),
  review_count integer check (review_count >= 0),
  review_total integer check (review_total >= 0),
  summary_date date,
  metrics_updated_at timestamptz,
  reviews_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, source, store_key)
);

-- 日別の数値。PVは表示回数。未掲載は NULL（実測0と区別）。rating / review_count はその日に確認した店舗の値。
create table if not exists public.source_daily_metrics (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('tabelog','hotpepper','google','toreta','retty')),
  store_key text not null check (store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  date date not null,
  pv integer check (pv >= 0), pv_sp integer check (pv_sp >= 0), pv_pc integer check (pv_pc >= 0),
  pv_app integer check (pv_app >= 0), pv_other integer check (pv_other >= 0),
  reservations integer check (reservations >= 0), reservation_amount bigint check (reservation_amount >= 0),
  covers integer check (covers >= 0), visits integer check (visits >= 0), calls integer check (calls >= 0),
  rating numeric(4,2) check (rating between 0 and 5), review_count integer check (review_count >= 0),
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  run_id uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, source, store_key, date)
);
create index if not exists source_daily_metrics_user_source_date on public.source_daily_metrics(user_id, source, date);

-- 月別の数値。complete = 前月以前（サーバー判定）。derived = 日別の合計から作成（明示の月別値を上書きしない）。
create table if not exists public.source_monthly_metrics (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('tabelog','hotpepper','google','toreta','retty')),
  store_key text not null check (store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  complete boolean not null default false,
  derived boolean not null default false,
  pv integer check (pv >= 0), pv_sp integer check (pv_sp >= 0), pv_pc integer check (pv_pc >= 0),
  pv_app integer check (pv_app >= 0), pv_other integer check (pv_other >= 0),
  reservations integer check (reservations >= 0), reservation_amount bigint check (reservation_amount >= 0),
  covers integer check (covers >= 0), visits integer check (visits >= 0), calls integer check (calls >= 0),
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  run_id uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, source, store_key, month)
);

-- 口コミ。サイトの識別子（external_id）で一意。取り込みに無い過去行は削除しない。
create table if not exists public.source_reviews (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('tabelog','hotpepper','google','toreta','retty')),
  store_key text not null check (store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  external_id text not null check (external_id ~ '^[0-9A-Za-z._:#-]{1,200}$'),
  rating numeric(4,2) check (rating between 0 and 5),
  scores jsonb not null default '[]'::jsonb,
  title text not null default '',
  text text not null default '',
  text_complete boolean not null default true,
  author text,
  review_date date, visit_date date, visit_month text, published_at date,
  status text,
  reply_text text, reply_date date, reply_status text,
  needs_reply boolean,
  details jsonb not null default '{}'::jsonb,
  run_id uuid,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source, store_key, external_id)
);

-- サイト固有の詳細レポート（食べログのエリア順位・よく見られるページ等）。kind×period で上書き。
create table if not exists public.agent_reports (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('tabelog','hotpepper','google','toreta','retty')),
  store_key text not null check (store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  period text not null check (period ~ '^[0-9A-Za-z_:-]{1,40}$'),
  data jsonb not null,
  run_id uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, source, store_key, kind, period)
);

create table if not exists public.agent_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  run_key text not null check (run_key ~ '^[0-9A-Za-z._:-]{1,100}$'),
  agent text not null default '',
  request_id uuid,
  captured_at timestamptz,
  received_at timestamptz not null default now(),
  status text not null check (status in ('ok','partial')),
  stores integer not null default 0, days integer not null default 0, months integer not null default 0,
  reviews integer not null default 0, new_reviews integer not null default 0, reports integer not null default 0,
  message text not null default '',
  unique (user_id, source, run_key)
);
create index if not exists agent_ingest_runs_user_received on public.agent_ingest_runs(user_id, received_at desc);

do $$ declare t text; begin
  foreach t in array array['source_stores','source_daily_metrics','source_monthly_metrics','source_reviews','agent_reports','agent_ingest_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t || '_owner_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ========== 3) 取り込み（service_role のみ。agent-api が検証後に呼ぶ）==========
-- 1回の取り込みを1トランザクションで保存。同じ run_key・日・月・口コミIDの再送は上書き（冪等）。
-- 数値は NULL で既存値を消さない（未取得の項目を0や空にしない）。取り込みに無い行は保持する。
create or replace function public.ingest_source(p_user uuid, p_source text, p_run jsonb, p_stores jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_run uuid; s jsonb; d jsonb; m jsonb; r jsonb; rp jsonb; v_key text; v_summary date := (p_run->>'summary_date')::date;
  v_dates date[] := '{}'; v_months text[] := '{}'; saved jsonb; col text; inserted boolean; v_has_summary boolean := false;
  n_days int := 0; n_months int := 0; n_reviews int := 0; n_new int := 0; n_reports int := 0;
  cols text[] := array['pv','pv_sp','pv_pc','pv_app','pv_other','reservations','reservation_amount','covers','visits','calls'];
begin
  if p_user is null or p_source not in ('tabelog','hotpepper','google','toreta','retty') or jsonb_typeof(p_stores) <> 'array' or jsonb_array_length(p_stores) = 0 then
    raise exception 'Invalid ingest';
  end if;
  if coalesce(p_run->>'status','') not in ('ok','partial') or v_summary is null then raise exception 'Invalid ingest run'; end if;
  insert into public.agent_ingest_runs(user_id,source,run_key,agent,request_id,captured_at,status,message)
    values(p_user,p_source,p_run->>'run_key',coalesce(p_run->>'agent',''),(p_run->>'request_id')::uuid,(p_run->>'captured_at')::timestamptz,p_run->>'status',coalesce(p_run->>'message',''))
    on conflict(user_id,source,run_key) do update set received_at=now(),agent=excluded.agent,request_id=excluded.request_id,
      captured_at=excluded.captured_at,status=excluded.status,message=excluded.message
    returning id into v_run;
  for s in select value from jsonb_array_elements(p_stores) loop
    v_key := coalesce(s->>'store_key','');
    insert into public.source_stores(user_id,source,store_key,name,rating,review_count,review_total,summary_date,metrics_updated_at,reviews_updated_at)
      values(p_user,p_source,v_key,nullif(s->>'name',''),(s->>'rating')::numeric,(s->>'review_count')::int,(s->>'review_total')::int,
        case when s->>'rating' is not null or s->>'review_count' is not null then v_summary end,
        case when jsonb_array_length(coalesce(s->'days','[]')) + jsonb_array_length(coalesce(s->'months','[]')) > 0 then now() end,
        case when (s->>'reviews_included')::boolean then now() end)
      on conflict(user_id,source,store_key) do update set
        name=coalesce(excluded.name,source_stores.name), rating=coalesce(excluded.rating,source_stores.rating),
        review_count=coalesce(excluded.review_count,source_stores.review_count), review_total=coalesce(excluded.review_total,source_stores.review_total),
        summary_date=coalesce(excluded.summary_date,source_stores.summary_date),
        metrics_updated_at=coalesce(excluded.metrics_updated_at,source_stores.metrics_updated_at),
        reviews_updated_at=coalesce(excluded.reviews_updated_at,source_stores.reviews_updated_at), updated_at=now();
    if s->>'rating' is not null or s->>'review_count' is not null then
      v_has_summary := true;
      insert into public.source_daily_metrics(user_id,source,store_key,date,rating,review_count,run_id)
        values(p_user,p_source,v_key,v_summary,(s->>'rating')::numeric,(s->>'review_count')::int,v_run)
        on conflict(user_id,source,store_key,date) do update set rating=coalesce(excluded.rating,source_daily_metrics.rating),
          review_count=coalesce(excluded.review_count,source_daily_metrics.review_count), run_id=excluded.run_id, updated_at=now();
    end if;
    for d in select value from jsonb_array_elements(coalesce(s->'days','[]')) loop
      insert into public.source_daily_metrics as t(user_id,source,store_key,date,pv,pv_sp,pv_pc,pv_app,pv_other,reservations,reservation_amount,covers,visits,calls,extra,run_id)
      values(p_user,p_source,v_key,(d->>'date')::date,(d->>'pv')::int,(d->>'pv_sp')::int,(d->>'pv_pc')::int,(d->>'pv_app')::int,(d->>'pv_other')::int,
        (d->>'reservations')::int,(d->>'reservation_amount')::bigint,(d->>'covers')::int,(d->>'visits')::int,(d->>'calls')::int,coalesce(d->'extra','{}'),v_run)
      on conflict(user_id,source,store_key,date) do update set
        pv=coalesce(excluded.pv,t.pv), pv_sp=coalesce(excluded.pv_sp,t.pv_sp), pv_pc=coalesce(excluded.pv_pc,t.pv_pc),
        pv_app=coalesce(excluded.pv_app,t.pv_app), pv_other=coalesce(excluded.pv_other,t.pv_other),
        reservations=coalesce(excluded.reservations,t.reservations), reservation_amount=coalesce(excluded.reservation_amount,t.reservation_amount),
        covers=coalesce(excluded.covers,t.covers), visits=coalesce(excluded.visits,t.visits), calls=coalesce(excluded.calls,t.calls),
        extra=t.extra || excluded.extra, run_id=excluded.run_id, updated_at=now()
      returning to_jsonb(t) into saved;
      foreach col in array cols loop
        if d->>col is not null and (saved->>col) is distinct from (d->>col) then raise exception 'Saved metric mismatch: %', col; end if;
      end loop;
      v_dates := v_dates || (d->>'date')::date; n_days := n_days + 1;
    end loop;
    for m in select value from jsonb_array_elements(coalesce(s->'months','[]')) loop
      insert into public.source_monthly_metrics as t(user_id,source,store_key,month,complete,derived,pv,pv_sp,pv_pc,pv_app,pv_other,reservations,reservation_amount,covers,visits,calls,extra,run_id)
      values(p_user,p_source,v_key,m->>'month',coalesce((m->>'complete')::boolean,false),coalesce((m->>'derived')::boolean,false),
        (m->>'pv')::int,(m->>'pv_sp')::int,(m->>'pv_pc')::int,(m->>'pv_app')::int,(m->>'pv_other')::int,
        (m->>'reservations')::int,(m->>'reservation_amount')::bigint,(m->>'covers')::int,(m->>'visits')::int,(m->>'calls')::int,coalesce(m->'extra','{}'),v_run)
      on conflict(user_id,source,store_key,month) do update set
        complete=excluded.complete, derived=excluded.derived,
        pv=coalesce(excluded.pv,t.pv), pv_sp=coalesce(excluded.pv_sp,t.pv_sp), pv_pc=coalesce(excluded.pv_pc,t.pv_pc),
        pv_app=coalesce(excluded.pv_app,t.pv_app), pv_other=coalesce(excluded.pv_other,t.pv_other),
        reservations=coalesce(excluded.reservations,t.reservations), reservation_amount=coalesce(excluded.reservation_amount,t.reservation_amount),
        covers=coalesce(excluded.covers,t.covers), visits=coalesce(excluded.visits,t.visits), calls=coalesce(excluded.calls,t.calls),
        extra=t.extra || excluded.extra, run_id=excluded.run_id, updated_at=now()
      where not (excluded.derived and not t.derived);
      v_months := v_months || (m->>'month'); n_months := n_months + 1;
    end loop;
    for r in select value from jsonb_array_elements(coalesce(s->'reviews','[]')) loop
      insert into public.source_reviews(user_id,source,store_key,external_id,rating,scores,title,text,text_complete,author,review_date,visit_date,visit_month,published_at,status,reply_text,reply_date,reply_status,needs_reply,details,run_id)
      values(p_user,p_source,v_key,r->>'external_id',(r->>'rating')::numeric,coalesce(r->'scores','[]'),coalesce(r->>'title',''),coalesce(r->>'text',''),
        coalesce((r->>'text_complete')::boolean,true),r->>'author',(r->>'review_date')::date,(r->>'visit_date')::date,r->>'visit_month',(r->>'published_at')::date,
        r->>'status',r->>'reply_text',(r->>'reply_date')::date,r->>'reply_status',(r->>'needs_reply')::boolean,coalesce(r->'details','{}'),v_run)
      on conflict(user_id,source,store_key,external_id) do update set
        rating=excluded.rating, scores=excluded.scores, title=excluded.title, text=excluded.text, text_complete=excluded.text_complete,
        author=excluded.author, review_date=excluded.review_date, visit_date=excluded.visit_date, visit_month=excluded.visit_month,
        published_at=excluded.published_at, status=excluded.status, reply_text=excluded.reply_text, reply_date=excluded.reply_date,
        reply_status=excluded.reply_status, needs_reply=excluded.needs_reply, details=excluded.details, run_id=excluded.run_id, updated_at=now()
      returning (xmax = 0) into inserted;
      n_reviews := n_reviews + 1;
      if inserted then n_new := n_new + 1; end if;
    end loop;
    for rp in select value from jsonb_array_elements(coalesce(s->'reports','[]')) loop
      insert into public.agent_reports(user_id,source,store_key,kind,period,data,run_id)
        values(p_user,p_source,v_key,rp->>'kind',rp->>'period',rp->'data',v_run)
        on conflict(user_id,source,store_key,kind,period) do update set data=excluded.data, run_id=excluded.run_id, updated_at=now();
      n_reports := n_reports + 1;
    end loop;
  end loop;
  -- 全サイト共通のKPI・PV推移用に、そのサイトの全店舗合計を snapshots へ反映（他の列・旧データの他の日は変更しない）。
  insert into public.snapshots(user_id,source,date,pv)
    select p_user,p_source,x.date,sum(x.pv) from public.source_daily_metrics x
    where x.user_id=p_user and x.source=p_source and x.date = any(v_dates) group by x.date having count(x.pv) > 0
    on conflict(user_id,source,date) do update set pv=excluded.pv;
  insert into public.snapshots(user_id,source,date,reservations)
    select p_user,p_source,(x.month || '-01')::date,sum(x.reservations) from public.source_monthly_metrics x
    where x.user_id=p_user and x.source=p_source and x.month = any(v_months) group by x.month having count(x.reservations) > 0
    on conflict(user_id,source,date) do update set reservations=excluded.reservations;
  if v_has_summary then
    -- 評価は店舗の最新値の平均（小数第2位）、口コミ数は合計
    insert into public.snapshots(user_id,source,date,rating,reviews)
      select p_user,p_source,v_summary,round(avg(x.rating),2),sum(x.review_count) from public.source_stores x
      where x.user_id=p_user and x.source=p_source having count(x.rating) > 0 or count(x.review_count) > 0
      on conflict(user_id,source,date) do update set rating=coalesce(excluded.rating,snapshots.rating), reviews=coalesce(excluded.reviews,snapshots.reviews);
  end if;
  update public.agent_ingest_runs set stores=jsonb_array_length(p_stores), days=n_days, months=n_months, reviews=n_reviews, new_reviews=n_new, reports=n_reports where id=v_run;
  insert into public.sync_log(user_id,source,status,message) values(p_user,p_source,p_run->>'status',left(coalesce(p_run->>'message',''),500));
  return jsonb_build_object('run_id',v_run,'stores',jsonb_array_length(p_stores),'days',n_days,'months',n_months,'reviews',n_reviews,'new_reviews',n_new,'reports',n_reports);
end;
$$;
revoke all on function public.ingest_source(uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_source(uuid,text,jsonb,jsonb) to service_role;

-- ========== 4) アプリ → Grok Bot の取得依頼キュー ==========
-- ブラウザ（本人）は依頼の登録と自分の依頼の閲覧のみ。状態の変更は agent-api（service_role の関数）だけ。
create table if not exists public.agent_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id text not null default '' check (store_id ~ '^[0-9A-Za-z_-]{0,40}$'),
  source text not null check (source in ('tabelog','hotpepper','google','toreta','ikyu','retty')),
  action text not null default 'sync_now' check (action in ('sync_now','fetch_metrics','fetch_reviews','backfill')),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object' and length(params::text) <= 2000),
  status text not null default 'queued' check (status in ('queued','claimed','done','failed')),
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  claimed_by text,
  claim_id uuid,
  attempts integer not null default 0,
  result jsonb,
  error text check (length(error) <= 1000),
  check (source <> 'ikyu' or store_id ~ '^[0-9]{6}$')
);
-- 同じ店舗×サイト×内容の未完了の依頼は1件だけ（重複依頼は 23505 で拒否）
create unique index if not exists agent_requests_one_open on public.agent_requests(user_id, source, store_id, action) where status in ('queued','claimed');
create index if not exists agent_requests_queue on public.agent_requests(user_id, requested_at) where status = 'queued';
create index if not exists agent_requests_user_requested on public.agent_requests(user_id, requested_at desc);

-- 登録時の強制: 状態は queued から、利用者は本人、1時間30件・未完了20件まで（DB側の件数制限）
create or replace function public.agent_requests_before_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.status := 'queued'; new.claimed_at := null; new.finished_at := null; new.claimed_by := null; new.claim_id := null;
  new.attempts := 0; new.result := null; new.error := null; new.requested_at := now();
  perform pg_advisory_xact_lock(hashtextextended('agent_requests:' || new.user_id::text, 0));
  if (select count(*) from public.agent_requests where user_id = new.user_id and requested_at > now() - interval '1 hour') >= 30 then
    raise exception '取得依頼が多すぎます。1時間あたり30件までです' using errcode = 'P0429';
  end if;
  if (select count(*) from public.agent_requests where user_id = new.user_id and status in ('queued','claimed')) >= 20 then
    raise exception '未完了の取得依頼が多すぎます。完了を待ってから依頼してください' using errcode = 'P0429';
  end if;
  return new;
end;
$$;
drop trigger if exists agent_requests_before_insert on public.agent_requests;
create trigger agent_requests_before_insert before insert on public.agent_requests for each row execute function public.agent_requests_before_insert();
revoke all on function public.agent_requests_before_insert() from public, anon, authenticated;

alter table public.agent_requests enable row level security;
drop policy if exists agent_requests_owner_read on public.agent_requests;
drop policy if exists agent_requests_owner_insert on public.agent_requests;
create policy agent_requests_owner_read on public.agent_requests for select to authenticated using ((select auth.uid()) = user_id);
create policy agent_requests_owner_insert on public.agent_requests for insert to authenticated with check ((select auth.uid()) = user_id and status = 'queued');
revoke all on public.agent_requests from anon, authenticated;
grant insert (store_id, source, action, params) on public.agent_requests to authenticated;
grant select (id, user_id, store_id, source, action, params, status, requested_at, claimed_at, finished_at, claimed_by, attempts, result, error) on public.agent_requests to authenticated;

-- 取得開始（原子的・複数エージェントでも二重取得しない）。30分以上完了報告の無い取得中は再度 queued（3回で失敗）。
-- 24時間拾われなかった依頼は失敗にする。
create or replace function public.claim_agent_requests(p_user uuid, p_agent text, p_limit integer default 1, p_source text default null)
returns setof public.agent_requests language plpgsql set search_path = '' as $$
begin
  if p_user is null then raise exception 'Invalid user'; end if;
  update public.agent_requests set status = 'failed', finished_at = now(), claim_id = null,
    error = case when status = 'queued' then '24時間以内に取得されませんでした。もう一度依頼してください' else '取得が完了しませんでした（3回）。管理画面の状態を確認してください' end
    where user_id = p_user and ((status = 'queued' and requested_at < now() - interval '24 hours')
      or (status = 'claimed' and claimed_at < now() - interval '30 minutes' and attempts >= 3));
  update public.agent_requests set status = 'queued', claimed_at = null, claimed_by = null, claim_id = null
    where user_id = p_user and status = 'claimed' and claimed_at < now() - interval '30 minutes';
  return query
    with picked as (
      select q.id from public.agent_requests q
      where q.user_id = p_user and q.status = 'queued' and (p_source is null or q.source = p_source)
      order by q.requested_at limit least(greatest(coalesce(p_limit, 1), 1), 20)
      for update skip locked
    )
    update public.agent_requests a set status = 'claimed', claimed_at = now(), claimed_by = left(coalesce(p_agent, ''), 100),
      claim_id = gen_random_uuid(), attempts = a.attempts + 1
    from picked where a.id = picked.id
    returning a.*;
end;
$$;

-- 完了・失敗の報告。claim_id が一致する取得中の依頼だけ更新。同じ報告の再送は成功扱い（冪等）。
create or replace function public.finish_agent_request(p_user uuid, p_id uuid, p_claim uuid, p_status text, p_result jsonb default null, p_error text default null)
returns public.agent_requests language plpgsql set search_path = '' as $$
declare v public.agent_requests;
begin
  if p_status not in ('done','failed') then raise exception 'Invalid status'; end if;
  update public.agent_requests set status = p_status, finished_at = now(), result = p_result, error = left(p_error, 1000)
    where id = p_id and user_id = p_user and claim_id = p_claim and status = 'claimed'
    returning * into v;
  if found then return v; end if;
  select * into v from public.agent_requests where id = p_id and user_id = p_user and claim_id = p_claim and status = p_status;
  if found then return v; end if;
  raise exception 'Invalid claim' using errcode = 'P0409';
end;
$$;
revoke all on function public.claim_agent_requests(uuid,text,integer,text), public.finish_agent_request(uuid,uuid,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.claim_agent_requests(uuid,text,integer,text), public.finish_agent_request(uuid,uuid,uuid,text,jsonb,text) to service_role;
