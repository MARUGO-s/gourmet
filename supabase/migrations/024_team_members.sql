-- 024（023_weekly_delivery_schedules の後）: チーム（持ち主のデータを、承認したメンバーが見る・操作する）。
-- 持ち主 = Grok Bot の取り込み先（INGEST_USER_ID。review-api / ai-analyst の TEAM_OWNER_ID で上書き可）。データの user_id は持ち主のまま。
-- ・ログインした人は「参加申請」（pending）→ 持ち主・管理者が承認（active）し、役割と担当店舗を決める。停止（suspended）・削除もできる。
-- ・管理者（admin）: 持ち主の全店舗。メンバー（member）: 担当店舗（team_member_stores）に割り当てたサイトの店舗コードの行だけ。
-- ・既存の持ち主の条件（auth.uid() = user_id）は変えない。承認済みメンバーの SELECT の条件を別の policy として足すだけ。
-- ・ログイン情報（credentials・credential_access_log）、AIのレポート・利用回数（作った本人だけ）、保存HTML（service_role だけ）は対象外。
-- ・書き込みは今までどおり review-api / ai-analyst（JWT と役割・担当店舗を確かめてから service_role、user_id は持ち主）。
-- 適用後に review-api・ai-analyst を配置する（README「チーム（migration 024）」）。

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null default '' check (length(email) <= 320),
  display_name text not null default '' check (length(display_name) <= 100),
  role text not null default 'member' check (role in ('admin','member')),
  status text not null default 'pending' check (status in ('pending','active','suspended')),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  -- 1人が入れるチームは1つ。持ち主は自分のチームのメンバーにならない
  constraint team_members_one_team unique (user_id),
  constraint team_members_id_owner unique (id, owner_id),
  check (owner_id <> user_id)
);
create index if not exists team_members_owner on public.team_members(owner_id, status);

-- メンバーの担当店舗（管理者は全店舗なので使わない）。店舗の削除・メンバーの削除で消える
create table if not exists public.team_member_stores (
  member_id uuid not null,
  owner_id uuid not null,
  store_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (member_id, store_id),
  constraint team_member_stores_member_fk foreign key (member_id, owner_id) references public.team_members(id, owner_id) on delete cascade,
  constraint team_member_stores_store_fk foreign key (store_id, owner_id) references public.stores(id, user_id) on delete cascade
);
create index if not exists team_member_stores_store on public.team_member_stores(store_id);

-- 取得依頼をした人（メンバーの依頼も user_id は持ち主。誰が依頼したかを残す）
alter table public.agent_requests add column if not exists requested_by uuid references auth.users(id) on delete set null;

-- ---------- 判定（RLS から呼ぶ。security definer で team_* を読む。auth.uid() は呼び出した人） ----------
-- 持ち主本人、または持ち主のチームの承認済み管理者
create or replace function public.team_can_read_all(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) = p_owner or exists (
    select 1 from public.team_members m
    where m.user_id = (select auth.uid()) and m.owner_id = p_owner and m.status = 'active' and m.role = 'admin');
$$;
-- 持ち主のチームの承認済みの人（役割を問わない。取り込みの記録など店舗に依らない行）
create or replace function public.team_is_active(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) = p_owner or exists (
    select 1 from public.team_members m
    where m.user_id = (select auth.uid()) and m.owner_id = p_owner and m.status = 'active');
$$;
-- 店舗（stores.id）を見られるか
create or replace function public.team_can_read_store(p_owner uuid, p_store text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.team_can_read_all(p_owner) or exists (
    select 1 from public.team_members m
    join public.team_member_stores ms on ms.member_id = m.id and ms.owner_id = m.owner_id
    where m.user_id = (select auth.uid()) and m.owner_id = p_owner and m.status = 'active' and m.role = 'member'
      and ms.store_id::text = p_store);
$$;
-- サイトの店舗コード（source_*.store_key・ikyu_*.store_id・agent_requests.store_id など）を見られるか。
-- 担当店舗に割り当てたサイトの店舗コードだけ（''＝既定の店舗コード。旧データ）
create or replace function public.team_can_read_key(p_owner uuid, p_source text, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.team_can_read_all(p_owner) or exists (
    select 1 from public.team_members m
    join public.team_member_stores ms on ms.member_id = m.id and ms.owner_id = m.owner_id
    join public.store_sites ss on ss.store_id = ms.store_id and ss.user_id = m.owner_id
    where m.user_id = (select auth.uid()) and m.owner_id = p_owner and m.status = 'active' and m.role = 'member'
      and ss.source = p_source and ss.site_store_key = coalesce(p_key, ''));
$$;
revoke all on function public.team_can_read_all(uuid), public.team_is_active(uuid), public.team_can_read_store(uuid,text),
  public.team_can_read_key(uuid,text,text) from public, anon;
grant execute on function public.team_can_read_all(uuid), public.team_is_active(uuid), public.team_can_read_store(uuid,text),
  public.team_can_read_key(uuid,text,text) to authenticated, service_role;

-- ---------- チームの表: 本人の行と、持ち主・管理者はチーム全員。書き込みは review-api（service_role）だけ ----------
alter table public.team_members enable row level security;
alter table public.team_member_stores enable row level security;
drop policy if exists team_members_read on public.team_members;
drop policy if exists team_member_stores_read on public.team_member_stores;
create policy team_members_read on public.team_members for select to authenticated
  using ((select auth.uid()) = user_id or public.team_can_read_all(owner_id));
create policy team_member_stores_read on public.team_member_stores for select to authenticated
  using (public.team_can_read_all(owner_id) or exists (
    select 1 from public.team_members m where m.id = member_id and m.user_id = (select auth.uid())));
revoke all on public.team_members, public.team_member_stores from anon, authenticated;
grant select on public.team_members, public.team_member_stores to authenticated;

-- ---------- 承認済みメンバーの SELECT（既存の持ち主の policy に足す） ----------
do $$
declare t text;
begin
  -- サイト×店舗コード（store_key）の行
  foreach t in array array['source_daily_metrics','source_monthly_metrics','source_reviews','source_stores','agent_reports','review_alert_events'] loop
    execute format('drop policy if exists %I on public.%I', t || '_team_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.team_can_read_key(user_id, source, store_key))', t || '_team_read', t);
  end loop;
  -- 一休（store_id = 一休の店舗ID）
  foreach t in array array['ikyu_daily_pageviews','ikyu_monthly_pageviews','ikyu_reviews','ikyu_stores'] loop
    execute format('drop policy if exists %I on public.%I', t || '_team_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.team_can_read_key(user_id, ''ikyu'', store_id))', t || '_team_read', t);
  end loop;
  -- 取得依頼・自動取得の設定（store_id = サイトの店舗コード）
  foreach t in array array['agent_requests','fetch_schedules'] loop
    execute format('drop policy if exists %I on public.%I', t || '_team_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.team_can_read_key(user_id, source, store_id))', t || '_team_read', t);
  end loop;
  -- 旧データ（店舗コードなし＝既定の店舗コード ''）
  foreach t in array array['snapshots','reviews','sync_log','source_reports'] loop
    execute format('drop policy if exists %I on public.%I', t || '_team_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.team_can_read_key(user_id, source, ''''))', t || '_team_read', t);
  end loop;
  -- 店舗（stores.id）の行
  foreach t in array array['review_alert_settings','review_alert_deliveries','weekly_delivery_schedules'] loop
    execute format('drop policy if exists %I on public.%I', t || '_team_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.team_can_read_store(user_id, store_id::text))', t || '_team_read', t);
  end loop;
  -- 取り込みの記録（店舗に依らない。データの鮮度に使う）
  foreach t in array array['agent_ingest_runs','ikyu_ingest_runs'] loop
    execute format('drop policy if exists %I on public.%I', t || '_team_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.team_is_active(user_id))', t || '_team_read', t);
  end loop;
end $$;
drop policy if exists stores_team_read on public.stores;
drop policy if exists store_sites_team_read on public.store_sites;
create policy stores_team_read on public.stores for select to authenticated using (public.team_can_read_store(user_id, id::text));
create policy store_sites_team_read on public.store_sites for select to authenticated using (public.team_can_read_store(user_id, store_id::text));
