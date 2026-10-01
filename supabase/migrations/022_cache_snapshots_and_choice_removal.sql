-- 022: M-talk の「最新を調べる / 今あるデータで答える」の選択を廃止し、毎日の取り込み（キャッシュ）を広げる。
--
-- 1) 選択の廃止: 進行中の質問（mtalk_live_lookups）を閉じる。表・列・origin = 'mtalk_live' は履歴と再ログイン後のお知らせのため残す。
--    awaiting_choice → expired、fetching / answering → timed_out（古いボタンが押されたら ai-analyst が2時間以内の質問にすぐ答える）。
-- 2) site_page_snapshots: 管理画面のページの保存HTML（まだ解析していない分析・統計・予約・プランのページ）。
--    店舗×サイト×ページ×期間で最新1件。予約一覧などお客様の個人情報を含むページがあるため、service_role だけが読み書きできる
--    （RLS 有効・ポリシー無し・anon / authenticated へ付与なし）。AI分析の関数・アプリ・M-talk には渡さない。
--    個人情報を含む行（contains_pii）は 120日で消す（purge_site_page_snapshots、pg_cron があれば毎日）。

-- ========== 1) 選択の廃止 ==========
update public.mtalk_live_lookups set status = 'expired', finished_at = coalesce(finished_at, now())
  where status = 'awaiting_choice';
update public.mtalk_live_lookups set status = 'timed_out', finished_at = coalesce(finished_at, now()), error = '選択の機能を廃止（2026-10-01）'
  where status in ('fetching', 'answering');

-- ========== 2) 管理画面のページの保存HTML ==========
create table if not exists public.site_page_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('ikyu', 'tabelog')),
  store_key text not null check (store_key ~ '^[0-9A-Za-z_-]{0,40}$'),
  page text not null check (page ~ '^[a-z][a-z0-9_]{0,59}$'),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'),
  url_path text not null default '' check (length(url_path) <= 500),
  html text not null check (octet_length(html) <= 3000000),
  bytes integer not null check (bytes between 0 and 3000000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  contains_pii boolean not null default false,
  captured_at timestamptz,
  received_at timestamptz not null default now(),
  run_key text not null check (run_key ~ '^[0-9A-Za-z._:-]{1,100}$'),
  parsed_at timestamptz,
  primary key (user_id, source, store_key, page, period),
  check (source <> 'ikyu' or store_key ~ '^[0-9]{6}$')
);
create index if not exists site_page_snapshots_unparsed on public.site_page_snapshots(user_id, source, page) where parsed_at is null;
create index if not exists site_page_snapshots_pii_received on public.site_page_snapshots(received_at) where contains_pii;

alter table public.site_page_snapshots enable row level security;
revoke all on public.site_page_snapshots from public, anon, authenticated;
grant select, insert, update, delete on public.site_page_snapshots to service_role;

-- 保存（同じページ・期間は上書き。HTML が変わったときだけ parsed_at を消して解析し直す対象にする）
create or replace function public.save_site_page_snapshots(p_user uuid, p_rows jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare r jsonb;
declare saved integer := 0;
declare changed integer := 0;
declare h text;
declare prev text;
begin
  if p_user is null then raise exception 'Invalid user'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20 then raise exception 'Invalid rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    h := encode(sha256(convert_to(r->>'html', 'UTF8')), 'hex');
    select sha256 into prev from public.site_page_snapshots
      where user_id = p_user and source = r->>'source' and store_key = r->>'store_key' and page = r->>'page' and period = r->>'period';
    insert into public.site_page_snapshots(user_id, source, store_key, page, period, url_path, html, bytes, sha256, contains_pii, captured_at, run_key)
    values (p_user, r->>'source', r->>'store_key', r->>'page', r->>'period', coalesce(r->>'url_path', ''), r->>'html',
            octet_length(r->>'html'), h, coalesce((r->>'contains_pii')::boolean, false), nullif(r->>'captured_at', '')::timestamptz, r->>'run_key')
    on conflict (user_id, source, store_key, page, period) do update set
      url_path = excluded.url_path, html = excluded.html, bytes = excluded.bytes, sha256 = excluded.sha256, contains_pii = excluded.contains_pii,
      captured_at = excluded.captured_at, received_at = now(), run_key = excluded.run_key,
      parsed_at = case when public.site_page_snapshots.sha256 = excluded.sha256 then public.site_page_snapshots.parsed_at else null end;
    saved := saved + 1;
    if prev is null or prev <> h then changed := changed + 1; end if;
  end loop;
  return jsonb_build_object('saved', saved, 'changed', changed);
end;
$$;
revoke all on function public.save_site_page_snapshots(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_site_page_snapshots(uuid, jsonb) to service_role;

-- 個人情報を含む保存HTMLの保存期間（既定120日）
create or replace function public.purge_site_page_snapshots(p_days integer default 120)
returns integer language plpgsql set search_path = '' as $$
declare n integer;
begin
  delete from public.site_page_snapshots where contains_pii and received_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.purge_site_page_snapshots(integer) from public, anon, authenticated;
grant execute on function public.purge_site_page_snapshots(integer) to service_role;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge-site-page-snapshots';
    perform cron.schedule('purge-site-page-snapshots', '17 4 * * *', 'select public.purge_site_page_snapshots(120)');
  end if;
end $$;
