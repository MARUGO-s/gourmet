-- 012（011_external_agent_ingest_and_requests の後）: 店舗×サイトごとの自動取得の設定（fetch_schedules）。
-- アプリは設定の保存と表示だけを行う。予定時刻になった設定を取得依頼（agent_requests）へ変えるのは
-- Grok Bot が呼ぶ agent-api POST /schedules/enqueue-due（service_role）だけ。アプリからサイトへは取得しない。
-- 次回予定（next_due_at）は supabase/functions/_shared/fetch-schedules.js（日本時間）で計算して保存する。
-- 既存の表・行は変更しない。適用後に review-api / agent-api を配置する（README「自動取得の設定」）。

create table if not exists public.fetch_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- agent_requests.store_id と同じ店舗コード（credentials.store_key と同じ値。''=既定の1店舗、一休は6桁の店舗ID）
  store_id text not null default '' check (store_id ~ '^[0-9A-Za-z_-]{0,40}$'),
  source text not null check (source in ('ikyu','tabelog','hotpepper','toreta','google')),
  mode text not null default 'off' check (mode in ('off','hourly_interval','daily','weekly')),
  interval_hours integer check (interval_hours between 1 and 168),
  time_of_day time check (time_of_day is null or extract(second from time_of_day) = 0), -- 日本時間
  weekday smallint check (weekday between 0 and 6), -- 0=日曜 … 6=土曜（日本時間）
  enabled boolean not null default true,
  last_enqueued_at timestamptz,
  last_request_id uuid,
  next_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint fetch_schedules_user_source_store unique (user_id, source, store_id),
  check (source <> 'ikyu' or store_id ~ '^[0-9]{6}$'),
  -- 周期ごとに必要な項目
  check (mode <> 'hourly_interval' or interval_hours is not null),
  check (mode not in ('daily','weekly') or time_of_day is not null),
  check (mode <> 'weekly' or weekday is not null),
  -- オフ・停止中は予定を持たない（取得依頼にならない）
  check ((mode <> 'off' and enabled) or next_due_at is null)
);
-- エージェントの「予定時刻を過ぎた設定」の検索用
create index if not exists fetch_schedules_due on public.fetch_schedules(user_id, next_due_at) where enabled and mode <> 'off';

-- 010 の credentials と同じ方針: ブラウザは本人の行の SELECT のみ。
-- 書き込みは review-api（JWT検証後、本人の user_id に限定して service_role で保存）と agent-api（service_role）だけ。
alter table public.fetch_schedules enable row level security;
drop policy if exists fetch_schedules_owner_read on public.fetch_schedules;
create policy fetch_schedules_owner_read on public.fetch_schedules for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.fetch_schedules from anon, authenticated;
grant select on public.fetch_schedules to authenticated;
