-- 013 の初期データ（任意・何度実行しても同じ結果）。migration 013_stores.sql の適用後に、SQLエディタまたは psql で1回実行する。
-- 対象: データ（資格情報・取得依頼・自動取得の設定・取り込みデータ・旧データ）を持つ既存の利用者全員。
-- 1) 24店舗を表示順 1〜24 で作成（同じ名前の店舗が既にあれば、その店舗の名前・表示順・割り当ては変更しない）。
-- 2) BISTRO CAVACAVA に 一休 112789・食べログ 13245351 を割り当てる。
-- 3) 食べログの既定の店舗コード ''（店舗コードなしで登録した資格情報・旧データ）も BISTRO CAVACAVA へ割り当てる。
--    ただし、その利用者に '' のデータがあり、かつ 13245351 以外の食べログの店舗コードが無い（'' が BISTRO CAVACAVA だと特定できる）場合だけ。
-- 既に別の店舗へ割り当て済みの店舗コードは変更しない（on conflict do nothing）。既存の他の表・行は変更しない。
begin;

create temporary table seed_store_names (sort_order integer primary key, name text not null) on commit drop;
insert into seed_store_names(sort_order, name) values
  (1, 'MARUGO-D'), (2, 'MARUGO-OTTO'), (3, '元祖どないや新宿三丁目'), (4, '鮨こるり'), (5, 'MARUGO'), (6, 'MARUGO2'),
  (7, 'MARUGO GRANDE'), (8, 'MARUGO MARUNOUCHI'), (9, 'マルゴ新橋'), (10, 'マルゴS'), (11, 'MARUGO YOTSUYA'), (12, '371BAR'),
  (13, '三三五五'), (14, 'BAR PELOTA'), (15, 'Claudia2'), (16, 'BISTRO CAVACAVA'), (17, 'eric''S'), (18, 'MITAN'),
  (19, '焼肉マルゴ'), (20, 'SOBA-JU'), (21, 'Bar Violet'), (22, 'X&C'), (23, 'トラットリア ブリッコラ'), (24, 'BLU NERO');

create temporary table seed_users on commit drop as
  select user_id from public.credentials
  union select user_id from public.agent_requests
  union select user_id from public.fetch_schedules
  union select user_id from public.snapshots
  union select user_id from public.reviews
  union select user_id from public.source_reports
  union select user_id from public.source_stores
  union select user_id from public.ikyu_stores
  union select user_id from public.sync_log;
-- 退会済みの利用者（auth.users に無い）は対象外
delete from seed_users su where not exists (select 1 from auth.users u where u.id = su.user_id);

insert into public.stores(user_id, name, sort_order)
  select su.user_id, n.name, n.sort_order from seed_users su cross join seed_store_names n
  on conflict (user_id, name) do nothing;

insert into public.store_sites(user_id, store_id, source, site_store_key)
  select s.user_id, s.id, x.source, x.site_store_key
  from public.stores s
  join seed_users su on su.user_id = s.user_id
  cross join (values ('ikyu', '112789'), ('tabelog', '13245351')) as x(source, site_store_key)
  where s.name = 'BISTRO CAVACAVA'
  on conflict (user_id, source, site_store_key) do nothing;

-- 食べログの '' : 旧データ（snapshots / reviews / source_reports の tabelog）、店舗コードなしの資格情報・取り込み・依頼・設定があり、
-- 13245351 と '' 以外の食べログの店舗コードが無い利用者だけ
insert into public.store_sites(user_id, store_id, source, site_store_key)
  select s.user_id, s.id, 'tabelog', ''
  from public.stores s
  join seed_users su on su.user_id = s.user_id
  where s.name = 'BISTRO CAVACAVA'
    and (
      exists (select 1 from public.credentials c where c.user_id = s.user_id and c.source = 'tabelog' and c.store_key = '')
      or exists (select 1 from public.source_stores x where x.user_id = s.user_id and x.source = 'tabelog' and x.store_key = '')
      or exists (select 1 from public.source_daily_metrics x where x.user_id = s.user_id and x.source = 'tabelog' and x.store_key = '')
      or exists (select 1 from public.source_reviews x where x.user_id = s.user_id and x.source = 'tabelog' and x.store_key = '')
      or exists (select 1 from public.agent_requests x where x.user_id = s.user_id and x.source = 'tabelog' and x.store_id = '')
      or exists (select 1 from public.fetch_schedules x where x.user_id = s.user_id and x.source = 'tabelog' and x.store_id = '')
      or exists (select 1 from public.snapshots x where x.user_id = s.user_id and x.source = 'tabelog')
      or exists (select 1 from public.reviews x where x.user_id = s.user_id and x.source = 'tabelog')
      or exists (select 1 from public.source_reports x where x.user_id = s.user_id and x.source = 'tabelog')
    )
    and not exists (
      select 1 from (
        select store_key as k from public.credentials where user_id = s.user_id and source = 'tabelog'
        union select store_key from public.source_stores where user_id = s.user_id and source = 'tabelog'
        union select store_key from public.source_daily_metrics where user_id = s.user_id and source = 'tabelog'
        union select store_key from public.source_monthly_metrics where user_id = s.user_id and source = 'tabelog'
        union select store_key from public.source_reviews where user_id = s.user_id and source = 'tabelog'
        union select store_id from public.agent_requests where user_id = s.user_id and source = 'tabelog'
        union select store_id from public.fetch_schedules where user_id = s.user_id and source = 'tabelog'
      ) keys where keys.k not in ('', '13245351')
    )
  on conflict (user_id, source, site_store_key) do nothing;

-- 確認用（実行結果に表示）: 利用者ごとの店舗数と BISTRO CAVACAVA の割り当て
select s.user_id, count(distinct s.id) as stores,
  string_agg(ss.source || ':' || case when ss.site_store_key = '' then '(既定)' else ss.site_store_key end, ', ' order by ss.source, ss.site_store_key)
    filter (where s.name = 'BISTRO CAVACAVA') as bistro_cavacava_sites
from public.stores s left join public.store_sites ss on ss.store_id = s.id
group by s.user_id;

commit;
