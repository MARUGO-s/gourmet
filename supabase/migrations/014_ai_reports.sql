-- 014（013_stores の後）: AI分析（ai-analyst）の保存レポート（ai_reports）と利用記録（ai_usage、1時間あたりの回数制限用）。
-- 既存の表・行は変更しない。書き込み・削除は ai-analyst（JWT検証後、本人の user_id に限定して service_role）だけ。
-- ブラウザ（authenticated）は本人の行の SELECT のみ（010〜013 と同じ）。適用後に ai-analyst を配置する。

create table if not exists public.ai_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 対象店舗（null＝全店舗）。店舗を削除してもレポートは残す（店舗名は作成時の値を保存）
  store_id uuid,
  store_name text not null check (length(store_name) between 1 and 200),
  period_from date not null,
  period_to date not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  markdown text not null check (length(markdown) <= 300000),
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  model text not null default '' check (length(model) <= 100),
  created_at timestamptz not null default now(),
  check (period_from <= period_to)
);
create index if not exists ai_reports_user_created on public.ai_reports(user_id, created_at desc);

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ask','report')),
  model text not null default '' check (length(model) <= 100),
  prompt_tokens integer check (prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens >= 0),
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_kind_created on public.ai_usage(user_id, kind, created_at desc);

alter table public.ai_reports enable row level security;
alter table public.ai_usage enable row level security;
drop policy if exists ai_reports_owner_read on public.ai_reports;
drop policy if exists ai_usage_owner_read on public.ai_usage;
create policy ai_reports_owner_read on public.ai_reports for select to authenticated using ((select auth.uid()) = user_id);
create policy ai_usage_owner_read on public.ai_usage for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.ai_reports, public.ai_usage from anon, authenticated;
grant select on public.ai_reports, public.ai_usage to authenticated;
