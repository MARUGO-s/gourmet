-- 017（016_ai_usage_mtalk の後）: 口コミ通知（新着口コミ・総合点の変化を M-talk の「AI分析」Bot から届ける）。
-- 検出は DB トリガー（取り込みと同じトランザクション）。誰がどの経路で取り込んでも、同じ口コミ・同じ変化は1回だけ記録される。
--   ・新着口コミ: source_reviews / ikyu_reviews への INSERT（既にある口コミの更新では通知しない）
--       - その店舗×サイトで初めての取り込み（以前に取り込んだ口コミが無い）は「baseline」＝記録だけで送らない（過去の口コミを一度に流さない）
--       - 投稿日が60日より前の口コミは「skipped（old）」＝記録だけ（過去ページの取り込み直しなど）
--       - 食べログは同じ口コミ（B…）が「抜粋」と「全文」の2行で入ることがあるので、口コミID（B…）単位で1回
--   ・総合点の変化: source_stores.rating が前の値（NULL 以外）から変わったとき（最初の値は通知しない）
--   このマイグレーションより前に取り込んだ口コミ・総合点は通知の対象にならない（適用時点の状態が基準）。
-- 送信は agent-api（取り込みの直後・取得依頼の確認のたび、service_role）が review_alert_events を確保して行う。
-- 送信の記録は review_alert_deliveries（送信先ごと）。M-talk 側も dedupe_key（gourmet-alert:<batch>）で二重投稿を防ぐ。
-- 設定（店舗ごとの送信先・オン/オフ）は review_alert_settings。書き込みは review-api（JWT検証後、本人の user_id に限定して service_role）だけ。
-- ブラウザは本人の行の SELECT のみ（013/015 と同じ）。適用後に agent-api・review-api を配置する（README「口コミ通知」）。

-- 食べログの公開店舗ページ（口コミへのリンク用。例 https://tabelog.com/tokyo/A1309/A130903/13245351/）。agent-api が取り込み時に保存する
alter table public.source_stores add column if not exists public_url text;
alter table public.source_stores drop constraint if exists source_stores_public_url_check;
alter table public.source_stores add constraint source_stores_public_url_check
  check (public_url is null or (length(public_url) <= 300 and public_url ~ '^https://tabelog\.com/[A-Za-z0-9/_-]+/[0-9]{8}/$'));

create table if not exists public.review_alert_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null,
  new_reviews boolean not null default true,
  score_changes boolean not null default true,
  -- M-talk の送信先 [{ "id": "<chat_users.id>", "name": "表示名" }]（20人まで）
  recipients jsonb not null default '[]'::jsonb check (jsonb_typeof(recipients) = 'array' and jsonb_array_length(recipients) <= 20),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (user_id, store_id),
  constraint review_alert_settings_store_fk foreign key (store_id, user_id) references public.stores(id, user_id) on delete cascade
);

create table if not exists public.review_alert_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('new_review', 'score_change')),
  source text not null check (source in ('tabelog','hotpepper','google','toreta','ikyu','retty')),
  store_key text not null check (store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  dedupe_key text not null check (length(dedupe_key) <= 300),
  -- 通知に載せる内容（検出時の値。口コミは本文を2000文字まで）
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'baseline', 'failed')),
  reason text check (reason is null or length(reason) <= 300),
  attempts integer not null default 0,
  batch_id uuid,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint review_alert_events_dedupe unique (user_id, dedupe_key)
);
create index if not exists review_alert_events_open on public.review_alert_events(user_id, created_at) where status in ('pending', 'sending');
create index if not exists review_alert_events_user_created on public.review_alert_events(user_id, created_at desc);

create table if not exists public.review_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  store_id uuid,
  store_name text,
  recipient_user_id uuid not null,
  recipient_name text,
  event_ids uuid[] not null default '{}',
  new_reviews integer not null default 0,
  score_changes integer not null default 0,
  status text not null check (status in ('sent', 'failed')),
  error text check (error is null or length(error) <= 300),
  mtalk_group_id bigint,
  mtalk_message_id bigint,
  deduplicated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_alert_deliveries_once unique (batch_id, recipient_user_id)
);
create index if not exists review_alert_deliveries_user_created on public.review_alert_deliveries(user_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['review_alert_settings','review_alert_events','review_alert_deliveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t || '_owner_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ========== 検出（トリガー） ==========
-- 状態: 以前に同じ店舗×サイトの口コミを取り込んでいなければ baseline、投稿日が60日より前なら skipped、それ以外は pending
create or replace function public.review_alert_initial_status(p_has_earlier boolean, p_posted date)
returns text language sql stable set search_path = '' as $$
  select case when not p_has_earlier then 'baseline'
              when p_posted is not null and p_posted < (now() at time zone 'Asia/Tokyo')::date - 60 then 'skipped'
              else 'pending' end
$$;

create or replace function public.review_alert_on_source_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_earlier boolean; v_status text; v_group text;
begin
  select exists(select 1 from public.source_reviews x where x.user_id = new.user_id and x.source = new.source and x.store_key = new.store_key
    and x.first_seen_at < new.first_seen_at) into v_earlier;
  v_status := public.review_alert_initial_status(v_earlier, new.review_date);
  -- 食べログ: B<数字>（抜粋 B…:excerpt と全文 B…:<訪問ID> は同じ口コミ）
  v_group := case when new.source = 'tabelog' then coalesce(substring(new.external_id from '^(B[0-9]+)'), new.external_id) else new.external_id end;
  insert into public.review_alert_events(user_id, kind, source, store_key, dedupe_key, payload, status, reason)
  values (new.user_id, 'new_review', new.source, new.store_key, format('review:%s:%s:%s', new.source, new.store_key, v_group),
    jsonb_build_object('external_id', new.external_id, 'group_id', v_group, 'rating', new.rating, 'title', left(new.title, 300),
      'text', left(new.text, 2000), 'text_complete', new.text_complete, 'review_date', new.review_date, 'visit_date', new.visit_date,
      'visit_month', new.visit_month, 'origin', new.details->>'origin'),
    v_status, case v_status when 'baseline' then '初回の取り込み（過去の口コミ）' when 'skipped' then '投稿日が60日より前' end)
  on conflict (user_id, dedupe_key) do nothing;
  return null;
end $$;

create or replace function public.review_alert_on_ikyu_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_earlier boolean; v_status text;
begin
  select exists(select 1 from public.ikyu_reviews x where x.user_id = new.user_id and x.store_id = new.store_id
    and x.first_seen_at < new.first_seen_at) into v_earlier;
  v_status := public.review_alert_initial_status(v_earlier, new.posted_at);
  insert into public.review_alert_events(user_id, kind, source, store_key, dedupe_key, payload, status, reason)
  values (new.user_id, 'new_review', 'ikyu', new.store_id, format('review:ikyu:%s:%s', new.store_id, new.reservation_no),
    jsonb_build_object('external_id', new.reservation_no, 'rating', new.rating, 'title', left(new.title, 300), 'text', left(new.text, 2000),
      'text_complete', true, 'review_date', new.posted_at, 'visit_date', new.visit_date, 'visit_month', to_char(new.visit_date, 'YYYY-MM')),
    v_status, case v_status when 'baseline' then '初回の取り込み（過去の口コミ）' when 'skipped' then '投稿日が60日より前' end)
  on conflict (user_id, dedupe_key) do nothing;
  return null;
end $$;

create or replace function public.review_alert_on_store_rating() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_date date := coalesce(new.summary_date, (now() at time zone 'Asia/Tokyo')::date);
begin
  insert into public.review_alert_events(user_id, kind, source, store_key, dedupe_key, payload)
  values (new.user_id, 'score_change', new.source, new.store_key,
    format('score:%s:%s:%s:%s:%s', new.source, new.store_key, old.rating, new.rating, v_date),
    jsonb_build_object('from', old.rating, 'to', new.rating, 'date', v_date, 'review_count_from', old.review_count, 'review_count_to', new.review_count))
  on conflict (user_id, dedupe_key) do nothing;
  return null;
end $$;

drop trigger if exists review_alert_new_source_review on public.source_reviews;
create trigger review_alert_new_source_review after insert on public.source_reviews
  for each row execute function public.review_alert_on_source_review();
drop trigger if exists review_alert_new_ikyu_review on public.ikyu_reviews;
create trigger review_alert_new_ikyu_review after insert on public.ikyu_reviews
  for each row execute function public.review_alert_on_ikyu_review();
drop trigger if exists review_alert_store_rating on public.source_stores;
create trigger review_alert_store_rating after update of rating on public.source_stores
  for each row when (old.rating is not null and new.rating is not null and old.rating is distinct from new.rating)
  execute function public.review_alert_on_store_rating();

-- ========== 送信の確保（agent-api だけ） ==========
-- pending と、10分以上 sending のまま止まったものを sending にして返す（FOR UPDATE SKIP LOCKED で同時実行でも1回だけ）。
-- batch_id は止まった送信のものをそのまま残す（M-talk 側の dedupe_key が同じになり、送信済みなら二重に投稿されない）。
create or replace function public.claim_review_alert_events(p_user uuid, p_limit integer default 50)
returns setof public.review_alert_events language plpgsql set search_path = '' as $$
begin
  if p_user is null or p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'Invalid claim'; end if;
  return query
  update public.review_alert_events e set status = 'sending', claimed_at = now(), attempts = e.attempts + 1
  where e.id in (
    select x.id from public.review_alert_events x
    where x.user_id = p_user and (x.status = 'pending' or (x.status = 'sending' and x.claimed_at < now() - interval '10 minutes'))
    order by x.created_at, x.id limit p_limit for update skip locked)
  returning e.*;
end $$;

do $$ declare f text; begin
  foreach f in array array['public.review_alert_initial_status(boolean,date)', 'public.review_alert_on_source_review()',
    'public.review_alert_on_ikyu_review()', 'public.review_alert_on_store_rating()', 'public.claim_review_alert_events(uuid,integer)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.claim_review_alert_events(uuid,integer) to service_role;
