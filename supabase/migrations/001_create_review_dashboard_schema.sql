-- Review Command Center: データモデル
-- 4テーブル + RLS（ユーザー単位の所有権: auth.uid() = user_id）

-- 1) サイト別ログイン資格情報（暗号化済みパスワード）
create table if not exists public.credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  label text not null default '',
  username text not null,
  password_enc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source)
);
alter table public.credentials enable row level security;
drop policy if exists credentials_owner_all on public.credentials;
create policy credentials_owner_all on public.credentials
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2) 日次スナップショット（評価点 / 口コミ数 / PV / 訪問数 / 予約数）
create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  date date not null,
  rating numeric(3,1) not null default 0,
  reviews integer not null default 0,
  pv integer not null default 0,
  visits integer not null default 0,
  reservations integer not null default 0,
  unique (user_id, source, date)
);
alter table public.snapshots enable row level security;
drop policy if exists snapshots_owner_all on public.snapshots;
create policy snapshots_owner_all on public.snapshots
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index if not exists snapshots_user_source_date
  on public.snapshots (user_id, source, date);

-- 3) 口コミ
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  rating numeric(2,1) not null default 0,
  text text not null default '',
  author text not null default '匿名',
  sentiment text not null default 'neutral',
  review_date date not null,
  created_at timestamptz not null default now()
);
alter table public.reviews enable row level security;
drop policy if exists reviews_owner_all on public.reviews;
create policy reviews_owner_all on public.reviews
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index if not exists reviews_user_date
  on public.reviews (user_id, review_date desc);

-- 4) 同期ログ（レート制限・最終同期表示用）
create table if not exists public.sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  at timestamptz not null default now(),
  status text not null,
  message text not null default ''
);
alter table public.sync_log enable row level security;
drop policy if exists sync_log_owner_all on public.sync_log;
create policy sync_log_owner_all on public.sync_log
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index if not exists sync_log_user_source_at
  on public.sync_log (user_id, source, at desc);
