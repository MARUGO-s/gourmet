-- サイト別の詳細分析（エリア内ランキング・よく見られているページ・月別来店指標・日別デバイス別PV）
-- kind ごとに period（'YYYY-MM' / 'YYYY-MM-DD'）単位で JSON を保存する
create table if not exists public.source_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  kind text not null,
  period text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (user_id, source, kind, period)
);
alter table public.source_reports enable row level security;
drop policy if exists source_reports_owner_all on public.source_reports;
create policy source_reports_owner_all on public.source_reports
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index if not exists source_reports_user_source_kind_period
  on public.source_reports (user_id, source, kind, period desc);
