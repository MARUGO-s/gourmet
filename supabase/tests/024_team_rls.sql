-- migration 024（チーム）の RLS の確認。使い捨てのローカルDB（001〜024 を適用済み）で実行する。本番では実行しない。
--   docker exec -i <container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/024_team_rls.sql
-- すべて1つのトランザクションで行い、最後に rollback する（データは残らない）。失敗すると例外で止まる。
begin;

-- 利用者: 持ち主 O、管理者 A、メンバー M（店舗1）、メンバー M3（店舗3＝旧データの既定コード）、申請中 P、停止 S、無関係 X
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.com',    'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'admin@example.com',    'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'member@example.com',   'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000d', 'member3@example.com',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000e', 'pending@example.com',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000f', 'stopped@example.com',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-000000000010', 'outsider@example.com', 'authenticated', 'authenticated');

-- 店舗1（食べログ T1・一休 111111）、店舗2（食べログ T2・一休 222222）、店舗3（食べログ ''＝旧データ）
insert into public.stores (id, user_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '店舗1'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '店舗2'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '店舗3');
insert into public.store_sites (user_id, store_id, source, site_store_key) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'tabelog', 'T1'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'ikyu', '111111'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', 'tabelog', 'T2'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', 'ikyu', '222222'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003', 'tabelog', '');

insert into public.team_members (id, owner_id, user_id, email, role, status) values
  ('20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'admin@example.com',   'admin',  'active'),
  ('20000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000c', 'member@example.com',  'member', 'active'),
  ('20000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000d', 'member3@example.com', 'member', 'active'),
  ('20000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000e', 'pending@example.com', 'member', 'pending'),
  ('20000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000f', 'stopped@example.com', 'member', 'suspended');
insert into public.team_member_stores (member_id, owner_id, store_id) values
  ('20000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003'),
  -- 申請中・停止の人に店舗が残っていても見えない
  ('20000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001');

-- 持ち主のデータ（店舗1・店舗2・旧データ・どの店舗にも割り当てていないコード T9）
insert into public.source_daily_metrics (user_id, source, store_key, date, pv) values
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', 'T1', '2026-10-01', 10),
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', 'T2', '2026-10-01', 20),
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', 'T9', '2026-10-01', 90);
insert into public.ikyu_daily_pageviews (user_id, store_id, date, pv) values
  ('00000000-0000-0000-0000-00000000000a', '111111', '2026-10-01', 1),
  ('00000000-0000-0000-0000-00000000000a', '222222', '2026-10-01', 2);
insert into public.snapshots (user_id, source, date, pv) values
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', '2020-01-01', 5);
insert into public.agent_requests (user_id, source, store_id) values
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', 'T1'),
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', 'T2');
insert into public.review_alert_settings (user_id, store_id) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002');
insert into public.weekly_delivery_schedules (user_id, store_id) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002');
insert into public.agent_ingest_runs (user_id, source, run_key, status) values
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', 'run-1', 'ok');
insert into public.credentials (user_id, source, store_key, username, password_enc) values
  ('00000000-0000-0000-0000-00000000000a', 'tabelog', 'T1', 'u', 'x');

-- 見える行数を数える（呼び出した人として）
create function pg_temp.seen(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  -- auth.uid() は新しい形（request.jwt.claims）と古い形（request.jwt.claim.sub）の両方がある
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  set local role authenticated;
  execute p_sql into n;
  reset role;
  return n;
end $$;
create function pg_temp.expect(p_label text, p_got bigint, p_want bigint) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then raise exception 'NG %: % 行（期待 %）', p_label, p_got, p_want; end if;
  raise notice 'ok %', p_label;
end $$;

do $$
declare
  o uuid := '00000000-0000-0000-0000-00000000000a'; a uuid := '00000000-0000-0000-0000-00000000000b';
  m uuid := '00000000-0000-0000-0000-00000000000c'; m3 uuid := '00000000-0000-0000-0000-00000000000d';
  p uuid := '00000000-0000-0000-0000-00000000000e'; s uuid := '00000000-0000-0000-0000-00000000000f'; x uuid := '00000000-0000-0000-0000-000000000010';
begin
  -- 持ち主: 今までどおり全部（ログイン情報も）
  perform pg_temp.expect('持ち主 日別', pg_temp.seen(o, 'select count(*) from public.source_daily_metrics'), 3);
  perform pg_temp.expect('持ち主 店舗', pg_temp.seen(o, 'select count(*) from public.stores'), 3);
  perform pg_temp.expect('持ち主 ログイン情報', pg_temp.seen(o, 'select count(*) from public.credentials'), 1);
  perform pg_temp.expect('持ち主 メンバー', pg_temp.seen(o, 'select count(*) from public.team_members'), 5);

  -- 管理者: 持ち主の全データ（未割り当て T9 も）。ログイン情報は RLS では見えない（review-api が役割を確かめて読む）
  perform pg_temp.expect('管理者 日別', pg_temp.seen(a, 'select count(*) from public.source_daily_metrics'), 3);
  perform pg_temp.expect('管理者 一休', pg_temp.seen(a, 'select count(*) from public.ikyu_daily_pageviews'), 2);
  perform pg_temp.expect('管理者 店舗', pg_temp.seen(a, 'select count(*) from public.stores'), 3);
  perform pg_temp.expect('管理者 旧データ', pg_temp.seen(a, 'select count(*) from public.snapshots'), 1);
  perform pg_temp.expect('管理者 週報の配信', pg_temp.seen(a, 'select count(*) from public.weekly_delivery_schedules'), 2);
  perform pg_temp.expect('管理者 ログイン情報', pg_temp.seen(a, 'select count(*) from public.credentials'), 0);
  perform pg_temp.expect('管理者 メンバー', pg_temp.seen(a, 'select count(*) from public.team_members'), 5);

  -- メンバー（店舗1）: 店舗1のコード（T1・111111）の行だけ
  perform pg_temp.expect('メンバー 日別', pg_temp.seen(m, 'select count(*) from public.source_daily_metrics'), 1);
  perform pg_temp.expect('メンバー 日別は T1', pg_temp.seen(m, 'select count(*) from public.source_daily_metrics where store_key = ''T1'''), 1);
  perform pg_temp.expect('メンバー 一休', pg_temp.seen(m, 'select count(*) from public.ikyu_daily_pageviews where store_id = ''111111'''), 1);
  perform pg_temp.expect('メンバー 一休（他店）', pg_temp.seen(m, 'select count(*) from public.ikyu_daily_pageviews where store_id = ''222222'''), 0);
  perform pg_temp.expect('メンバー 店舗', pg_temp.seen(m, 'select count(*) from public.stores'), 1);
  perform pg_temp.expect('メンバー 店舗のサイト', pg_temp.seen(m, 'select count(*) from public.store_sites'), 2);
  perform pg_temp.expect('メンバー 旧データ', pg_temp.seen(m, 'select count(*) from public.snapshots'), 0);
  perform pg_temp.expect('メンバー 取得依頼', pg_temp.seen(m, 'select count(*) from public.agent_requests'), 1);
  perform pg_temp.expect('メンバー 口コミ通知', pg_temp.seen(m, 'select count(*) from public.review_alert_settings'), 1);
  perform pg_temp.expect('メンバー 週報の配信', pg_temp.seen(m, 'select count(*) from public.weekly_delivery_schedules'), 1);
  perform pg_temp.expect('メンバー 取り込みの記録', pg_temp.seen(m, 'select count(*) from public.agent_ingest_runs'), 1);
  perform pg_temp.expect('メンバー ログイン情報', pg_temp.seen(m, 'select count(*) from public.credentials'), 0);
  perform pg_temp.expect('メンバー メンバー（本人だけ）', pg_temp.seen(m, 'select count(*) from public.team_members'), 1);
  perform pg_temp.expect('メンバー 担当店舗（本人だけ）', pg_temp.seen(m, 'select count(*) from public.team_member_stores'), 1);

  -- メンバー（店舗3＝既定コード ''）: 旧データが見える。T9（未割り当て）は見えない
  perform pg_temp.expect('メンバー3 旧データ', pg_temp.seen(m3, 'select count(*) from public.snapshots'), 1);
  perform pg_temp.expect('メンバー3 日別', pg_temp.seen(m3, 'select count(*) from public.source_daily_metrics'), 0);

  -- 申請中・停止・無関係: 何も見えない（本人の申請の行だけ）
  perform pg_temp.expect('申請中 日別', pg_temp.seen(p, 'select count(*) from public.source_daily_metrics'), 0);
  perform pg_temp.expect('申請中 店舗', pg_temp.seen(p, 'select count(*) from public.stores'), 0);
  perform pg_temp.expect('申請中 取り込みの記録', pg_temp.seen(p, 'select count(*) from public.agent_ingest_runs'), 0);
  perform pg_temp.expect('申請中 本人の申請', pg_temp.seen(p, 'select count(*) from public.team_members'), 1);
  perform pg_temp.expect('停止 日別', pg_temp.seen(s, 'select count(*) from public.source_daily_metrics'), 0);
  perform pg_temp.expect('停止 店舗', pg_temp.seen(s, 'select count(*) from public.stores'), 0);
  perform pg_temp.expect('無関係 日別', pg_temp.seen(x, 'select count(*) from public.source_daily_metrics'), 0);
  perform pg_temp.expect('無関係 メンバー', pg_temp.seen(x, 'select count(*) from public.team_members'), 0);
  perform pg_temp.expect('無関係 一休', pg_temp.seen(x, 'select count(*) from public.ikyu_daily_pageviews'), 0);
end $$;

-- 書き込みはブラウザからできない（team_* は SELECT だけ）
do $$
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
  set local role authenticated;
  begin
    update public.team_members set role = 'admin' where user_id = '00000000-0000-0000-0000-00000000000c';
    raise exception 'NG: メンバーが自分を管理者にできた';
  exception when insufficient_privilege then raise notice 'ok メンバーは自分の役割を変えられない';
  end;
  begin
    insert into public.team_member_stores (member_id, owner_id, store_id) values
      ('20000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002');
    raise exception 'NG: メンバーが担当店舗を足せた';
  exception when insufficient_privilege then raise notice 'ok メンバーは担当店舗を足せない';
  end;
  begin
    insert into public.store_sites (user_id, store_id, source, site_store_key) values
      ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'tabelog', 'T2x');
    raise exception 'NG: メンバーが店舗のサイトを足せた';
  exception when insufficient_privilege then raise notice 'ok メンバーは店舗のサイトを足せない';
  end;
  reset role;
end $$;

-- 停止したら、担当店舗が残っていても見えなくなる
update public.team_members set status = 'suspended' where user_id = '00000000-0000-0000-0000-00000000000c';
do $$ begin
  perform pg_temp.expect('停止後のメンバー 日別', pg_temp.seen('00000000-0000-0000-0000-00000000000c', 'select count(*) from public.source_daily_metrics'), 0);
end $$;

rollback;
