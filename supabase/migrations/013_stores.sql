-- 013（012_fetch_schedules の後）: 店舗マスタ（stores）と、店舗ごとの各サイトの店舗ID（store_sites）。
-- 1店舗に一休の店舗ID・食べログの店舗コード・ホットペッパー／トレタ／Google／Retty のコードをまとめ、
-- 画面で「店舗の選択」「全店舗の比較」を行う（表示の絞り込みのみ。店長ごとの権限ではない）。
-- 既存の表・行は変更しない。店舗は作成しない（初期データは supabase/seed/013_seed_stores.sql を別途実行）。
-- 書き込みは review-api（JWT検証後、本人の user_id に限定して service_role）だけ。ブラウザは本人の行の SELECT のみ（010/012 と同じ）。
-- 適用後に review-api を配置する（README「店舗の選択（migration 013）の配置」）。

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100 and name = btrim(name)),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stores_user_name unique (user_id, name),
  -- store_sites の複合外部キー用（別の利用者の店舗へ割り当てられないようにする）
  constraint stores_id_user unique (id, user_id)
);
create index if not exists stores_user_sort on public.stores(user_id, sort_order);

-- サイトの店舗コード（credentials.store_key / agent_requests.store_id / fetch_schedules.store_id / source_*.store_key / ikyu_*.store_id と同じ値）。
-- ''＝既定の店舗コード（店舗コードなしで登録・取り込みした行、アプリ内取得の時代の旧データ）。
-- 同じ利用者・サイト・店舗コードは1店舗にだけ割り当てられる。1店舗に同じサイトの複数コードを割り当てることはできる。
create table if not exists public.store_sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null,
  source text not null check (source in ('tabelog','hotpepper','google','toreta','ikyu','retty')),
  site_store_key text not null default '' check (site_store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_sites_store_fk foreign key (store_id, user_id) references public.stores(id, user_id) on delete cascade,
  constraint store_sites_user_source_key unique (user_id, source, site_store_key),
  check (source <> 'ikyu' or site_store_key ~ '^[0-9]{6}$')
);
create index if not exists store_sites_store on public.store_sites(store_id);

alter table public.stores enable row level security;
alter table public.store_sites enable row level security;
drop policy if exists stores_owner_read on public.stores;
drop policy if exists store_sites_owner_read on public.store_sites;
create policy stores_owner_read on public.stores for select to authenticated using ((select auth.uid()) = user_id);
create policy store_sites_owner_read on public.store_sites for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.stores, public.store_sites from anon, authenticated;
grant select on public.stores, public.store_sites to authenticated;
