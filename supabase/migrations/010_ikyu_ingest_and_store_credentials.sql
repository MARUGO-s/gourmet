-- 010（009_ikyu_public_sync の後）: 一休データの外部取り込み（Grok Bot → agent-api → このDB）と、店舗×サイト単位の資格情報。
-- アプリ（ブラウザ・review-worker）は一休の管理画面にアクセスしない。一休の表はSELECTのみ。
-- 適用手順は README「一休.comレストラン（外部取り込み）」を参照。agent-api / review-api / review-worker と同時に配置する。

-- ========== 1) 資格情報: 店舗×サイト ==========
-- store_key: 一休=6桁の店舗ID。他サイトは任意の店舗コード（未指定は''＝従来の1件）。
alter table public.credentials
  add column if not exists store_key text not null default '',
  add column if not exists credentials_version integer not null default 1;
update public.credentials set store_key = split_part(username, chr(30), 1)
  where source = 'ikyu' and store_key = '' and split_part(username, chr(30), 1) ~ '^[0-9]{6}$';
alter table public.credentials drop constraint if exists credentials_user_id_source_key;
alter table public.credentials drop constraint if exists credentials_store_key_format;
-- NOT VALID: #9 より前に登録され店舗IDを読み取れない一休の行が本番にあっても適用が失敗しないようにする
-- （その行は店舗ID未設定として一覧に残り、登録し直すと検証済みの行になる）。新規・更新行は常に検証される。
alter table public.credentials add constraint credentials_store_key_format
  check (store_key ~ '^[0-9A-Za-z_-]{0,40}$' and (source <> 'ikyu' or store_key ~ '^[0-9]{6}$')) not valid;
alter table public.credentials drop constraint if exists credentials_user_source_store_key;
alter table public.credentials add constraint credentials_user_source_store_key unique (user_id, source, store_key);

-- ID・パスワードを変えたら版を上げる（取り込み側のキャッシュ更新判定に使う）
create or replace function public.bump_credentials_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.username is distinct from old.username or new.password_enc is distinct from old.password_enc then
    new.credentials_version := old.credentials_version + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists credentials_version_bump on public.credentials;
create trigger credentials_version_bump before update on public.credentials
  for each row execute function public.bump_credentials_version();

-- ブラウザは「登録済み・更新日時」だけ読める。ログインID・暗号文は読めない（書き込みは review-api 経由のみ）。
revoke select on public.credentials from authenticated;
grant select (id, user_id, source, label, store_key, credentials_version, created_at, updated_at) on public.credentials to authenticated;

-- 復号した資格情報の払い出し記録（agent-api が記録。利用者は自分の記録を閲覧可能）
create table if not exists public.credential_access_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  credential_id uuid,
  source text not null,
  store_key text not null,
  credentials_version integer,
  agent text not null default '',
  outcome text not null check (outcome in ('issued','unchanged','not_found','decrypt_failed')),
  accessed_at timestamptz not null default now()
);
create index if not exists credential_access_log_user_at on public.credential_access_log(user_id, accessed_at desc);
alter table public.credential_access_log enable row level security;
drop policy if exists credential_access_log_owner_read on public.credential_access_log;
create policy credential_access_log_owner_read on public.credential_access_log for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.credential_access_log from anon, authenticated;
grant select on public.credential_access_log to authenticated;

-- ========== 2) 一休の取り込みデータ ==========
create table if not exists public.ikyu_stores (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id text not null check (store_id ~ '^[0-9]{6}$'),
  name text,
  review_total integer check (review_total >= 0),
  pageviews_updated_at timestamptz,
  reviews_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, store_id)
);
-- 公開ページ（restaurant.ikyu.com/<店舗ID>）の総合評価・口コミ数。PR #11（009）の snapshots(source='ikyu') の評価と同じ値。
alter table public.ikyu_stores add column if not exists public_rating numeric(4,2) check (public_rating between 0 and 5);
alter table public.ikyu_stores add column if not exists public_review_count integer check (public_review_count >= 0);
alter table public.ikyu_stores add column if not exists public_updated_at timestamptz;

-- 日別PV（ページ種別×端末）。PVは表示回数（ユニークではない）。未掲載はNULL（実測0と区別）。
-- reservations / reservation_amount は、その日に受け付けた予約の件数・金額（管理画面の表示値）。
create table if not exists public.ikyu_daily_pageviews (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id text not null check (store_id ~ '^[0-9]{6}$'),
  date date not null,
  guide_sp integer check (guide_sp >= 0), guide_pc integer check (guide_pc >= 0), guide_total integer check (guide_total >= 0),
  plan_sp integer check (plan_sp >= 0), plan_pc integer check (plan_pc >= 0), plan_total integer check (plan_total >= 0),
  other_sp integer check (other_sp >= 0), other_pc integer check (other_pc >= 0), other_total integer check (other_total >= 0),
  sp integer check (sp >= 0), pc integer check (pc >= 0), pv integer check (pv >= 0),
  reservations integer check (reservations >= 0),
  reservation_amount bigint check (reservation_amount >= 0),
  run_id uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, store_id, date)
);
create index if not exists ikyu_daily_pageviews_user_date on public.ikyu_daily_pageviews(user_id, date);

-- 月合計（管理画面の合計行）。complete = 前月以前で全日数が揃った確定月。
create table if not exists public.ikyu_monthly_pageviews (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id text not null check (store_id ~ '^[0-9]{6}$'),
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  complete boolean not null default false,
  days integer not null default 0 check (days between 0 and 31),
  guide_sp integer check (guide_sp >= 0), guide_pc integer check (guide_pc >= 0), guide_total integer check (guide_total >= 0),
  plan_sp integer check (plan_sp >= 0), plan_pc integer check (plan_pc >= 0), plan_total integer check (plan_total >= 0),
  other_sp integer check (other_sp >= 0), other_pc integer check (other_pc >= 0), other_total integer check (other_total >= 0),
  sp integer check (sp >= 0), pc integer check (pc >= 0), pv integer check (pv >= 0),
  reservations integer check (reservations >= 0),
  reservation_amount bigint check (reservation_amount >= 0),
  run_id uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, store_id, month)
);

-- クチコミ。予約番号で一意。予約者の氏名は保存しない（ハンドルネームのみ）。取り込みに無い過去行は削除しない。
create table if not exists public.ikyu_reviews (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id text not null check (store_id ~ '^[0-9]{6}$'),
  reservation_no text not null check (reservation_no ~ '^[0-9A-Za-z-]{1,40}$'),
  visit_date date,
  visit_time text check (visit_time ~ '^[0-9]{2}:[0-9]{2}$'),
  posted_at date,
  published_at date,
  handle_name text,
  publication text,
  rating numeric(4,2) check (rating between 0 and 5),
  scores jsonb not null default '[]'::jsonb,
  title text not null default '',
  text text not null default '',
  reply_text text,
  reply_date date,
  processing text,
  needs_reply boolean not null default true,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  run_id uuid,
  primary key (user_id, store_id, reservation_no)
);
create index if not exists ikyu_reviews_user_posted on public.ikyu_reviews(user_id, posted_at desc);

create table if not exists public.ikyu_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_key text not null check (length(run_key) between 1 and 100),
  agent text not null default '',
  captured_at timestamptz,
  received_at timestamptz not null default now(),
  status text not null check (status in ('ok','partial')),
  stores integer not null default 0,
  days integer not null default 0,
  months integer not null default 0,
  reviews integer not null default 0,
  new_reviews integer not null default 0,
  message text not null default '',
  unique (user_id, run_key)
);
create index if not exists ikyu_ingest_runs_user_received on public.ikyu_ingest_runs(user_id, received_at desc);

alter table public.ikyu_stores enable row level security;
alter table public.ikyu_daily_pageviews enable row level security;
alter table public.ikyu_monthly_pageviews enable row level security;
alter table public.ikyu_reviews enable row level security;
alter table public.ikyu_ingest_runs enable row level security;
drop policy if exists ikyu_stores_owner_read on public.ikyu_stores;
drop policy if exists ikyu_daily_pageviews_owner_read on public.ikyu_daily_pageviews;
drop policy if exists ikyu_monthly_pageviews_owner_read on public.ikyu_monthly_pageviews;
drop policy if exists ikyu_reviews_owner_read on public.ikyu_reviews;
drop policy if exists ikyu_ingest_runs_owner_read on public.ikyu_ingest_runs;
create policy ikyu_stores_owner_read on public.ikyu_stores for select to authenticated using ((select auth.uid()) = user_id);
create policy ikyu_daily_pageviews_owner_read on public.ikyu_daily_pageviews for select to authenticated using ((select auth.uid()) = user_id);
create policy ikyu_monthly_pageviews_owner_read on public.ikyu_monthly_pageviews for select to authenticated using ((select auth.uid()) = user_id);
create policy ikyu_reviews_owner_read on public.ikyu_reviews for select to authenticated using ((select auth.uid()) = user_id);
create policy ikyu_ingest_runs_owner_read on public.ikyu_ingest_runs for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.ikyu_stores, public.ikyu_daily_pageviews, public.ikyu_monthly_pageviews, public.ikyu_reviews, public.ikyu_ingest_runs from anon, authenticated;
grant select on public.ikyu_stores, public.ikyu_daily_pageviews, public.ikyu_monthly_pageviews, public.ikyu_reviews, public.ikyu_ingest_runs to authenticated;

-- ========== 3) 取り込み（service_role のみ。agent-api が検証後に呼ぶ）==========
-- 1回の取り込みを1トランザクションで保存。同じ run_key の再送・同じ日/月/予約番号の再送は上書き（冪等）。
-- 取り込みに含まれない日・月・口コミは保持する。
create or replace function public.ingest_ikyu(p_user uuid, p_run jsonb, p_stores jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_run uuid; s jsonb; d jsonb; m jsonb; r jsonb; v_store text; v_dates date[] := '{}'; v_months text[] := '{}';
  saved_day public.ikyu_daily_pageviews; col text; n_days int := 0; n_months int := 0; n_reviews int := 0; n_new int := 0; inserted boolean;
  pub jsonb; v_public_dates boolean := false; n_public int := 0; stored_review public.reviews;
  cols text[] := array['guide_sp','guide_pc','guide_total','plan_sp','plan_pc','plan_total','other_sp','other_pc','other_total','sp','pc','pv','reservations','reservation_amount'];
begin
  if p_user is null or jsonb_typeof(p_stores) <> 'array' or jsonb_array_length(p_stores) = 0 then raise exception 'Invalid ingest'; end if;
  if coalesce(p_run->>'status','') not in ('ok','partial') then raise exception 'Invalid ingest status'; end if;
  insert into public.ikyu_ingest_runs(user_id,run_key,agent,captured_at,status,message)
    values(p_user,p_run->>'run_key',coalesce(p_run->>'agent',''),(p_run->>'captured_at')::timestamptz,p_run->>'status',coalesce(p_run->>'message',''))
    on conflict(user_id,run_key) do update set received_at=now(),agent=excluded.agent,captured_at=excluded.captured_at,status=excluded.status,message=excluded.message
    returning id into v_run;
  for s in select value from jsonb_array_elements(p_stores) loop
    v_store := s->>'store_id';
    if v_store is null or v_store !~ '^[0-9]{6}$' then raise exception 'Invalid store'; end if;
    insert into public.ikyu_stores(user_id,store_id,name,review_total,pageviews_updated_at,reviews_updated_at)
      values(p_user,v_store,nullif(s->>'name',''),(s->>'review_total')::int,
        case when jsonb_array_length(coalesce(s->'months','[]'))>0 then now() end,
        case when (s->>'reviews_included')::boolean then now() end)
      on conflict(user_id,store_id) do update set
        name=coalesce(excluded.name,ikyu_stores.name), review_total=coalesce(excluded.review_total,ikyu_stores.review_total),
        pageviews_updated_at=coalesce(excluded.pageviews_updated_at,ikyu_stores.pageviews_updated_at),
        reviews_updated_at=coalesce(excluded.reviews_updated_at,ikyu_stores.reviews_updated_at), updated_at=now();
    for d in select value from jsonb_array_elements(coalesce(s->'days','[]')) loop
      insert into public.ikyu_daily_pageviews(user_id,store_id,date,guide_sp,guide_pc,guide_total,plan_sp,plan_pc,plan_total,other_sp,other_pc,other_total,sp,pc,pv,reservations,reservation_amount,run_id)
      values(p_user,v_store,(d->>'date')::date,(d->>'guide_sp')::int,(d->>'guide_pc')::int,(d->>'guide_total')::int,(d->>'plan_sp')::int,(d->>'plan_pc')::int,(d->>'plan_total')::int,
        (d->>'other_sp')::int,(d->>'other_pc')::int,(d->>'other_total')::int,(d->>'sp')::int,(d->>'pc')::int,(d->>'pv')::int,(d->>'reservations')::int,(d->>'reservation_amount')::bigint,v_run)
      on conflict(user_id,store_id,date) do update set
        guide_sp=excluded.guide_sp, guide_pc=excluded.guide_pc, guide_total=excluded.guide_total,
        plan_sp=excluded.plan_sp, plan_pc=excluded.plan_pc, plan_total=excluded.plan_total,
        other_sp=excluded.other_sp, other_pc=excluded.other_pc, other_total=excluded.other_total,
        sp=excluded.sp, pc=excluded.pc, pv=excluded.pv, reservations=excluded.reservations, reservation_amount=excluded.reservation_amount,
        run_id=excluded.run_id, updated_at=now()
      returning * into saved_day;
      foreach col in array cols loop
        if (to_jsonb(saved_day)->>col) is distinct from (d->>col) then raise exception 'Saved PV mismatch: %', col; end if;
      end loop;
      v_dates := v_dates || (d->>'date')::date; n_days := n_days + 1;
    end loop;
    for m in select value from jsonb_array_elements(coalesce(s->'months','[]')) loop
      insert into public.ikyu_monthly_pageviews(user_id,store_id,month,complete,days,guide_sp,guide_pc,guide_total,plan_sp,plan_pc,plan_total,other_sp,other_pc,other_total,sp,pc,pv,reservations,reservation_amount,run_id)
      values(p_user,v_store,m->>'month',coalesce((m->>'complete')::boolean,false),coalesce((m->>'days')::int,0),(m->>'guide_sp')::int,(m->>'guide_pc')::int,(m->>'guide_total')::int,(m->>'plan_sp')::int,(m->>'plan_pc')::int,(m->>'plan_total')::int,
        (m->>'other_sp')::int,(m->>'other_pc')::int,(m->>'other_total')::int,(m->>'sp')::int,(m->>'pc')::int,(m->>'pv')::int,(m->>'reservations')::int,(m->>'reservation_amount')::bigint,v_run)
      on conflict(user_id,store_id,month) do update set
        complete=excluded.complete, days=excluded.days,
        guide_sp=excluded.guide_sp, guide_pc=excluded.guide_pc, guide_total=excluded.guide_total,
        plan_sp=excluded.plan_sp, plan_pc=excluded.plan_pc, plan_total=excluded.plan_total,
        other_sp=excluded.other_sp, other_pc=excluded.other_pc, other_total=excluded.other_total,
        sp=excluded.sp, pc=excluded.pc, pv=excluded.pv, reservations=excluded.reservations, reservation_amount=excluded.reservation_amount,
        run_id=excluded.run_id, updated_at=now();
      v_months := v_months || (m->>'month'); n_months := n_months + 1;
    end loop;
    for r in select value from jsonb_array_elements(coalesce(s->'reviews','[]')) loop
      insert into public.ikyu_reviews(user_id,store_id,reservation_no,visit_date,visit_time,posted_at,published_at,handle_name,publication,rating,scores,title,text,reply_text,reply_date,processing,needs_reply,run_id)
      values(p_user,v_store,r->>'reservation_no',(r->>'visit_date')::date,r->>'visit_time',(r->>'posted_at')::date,(r->>'published_at')::date,r->>'handle_name',r->>'publication',
        (r->>'rating')::numeric,coalesce(r->'scores','[]'::jsonb),coalesce(r->>'title',''),coalesce(r->>'text',''),r->>'reply_text',(r->>'reply_date')::date,r->>'processing',(r->>'needs_reply')::boolean,v_run)
      on conflict(user_id,store_id,reservation_no) do update set
        visit_date=excluded.visit_date, visit_time=excluded.visit_time, posted_at=excluded.posted_at, published_at=excluded.published_at,
        handle_name=excluded.handle_name, publication=excluded.publication, rating=excluded.rating, scores=excluded.scores, title=excluded.title,
        text=excluded.text, reply_text=excluded.reply_text, reply_date=excluded.reply_date, processing=excluded.processing,
        needs_reply=excluded.needs_reply, run_id=excluded.run_id, updated_at=now()
      returning (xmax = 0) into inserted;
      n_reviews := n_reviews + 1;
      if inserted then n_new := n_new + 1; end if;
    end loop;
    -- 公開ページの評価・口コミ（任意）。口コミは PR #11 と同じ旧 reviews 表・同じ口コミIDへ保存（既存行は更新）。
    pub := s->'public';
    if pub is not null and jsonb_typeof(pub) = 'object' then
      if (pub->>'rating') is not null or (pub->>'review_count') is not null then
        update public.ikyu_stores set
          public_rating = coalesce((pub->>'rating')::numeric, public_rating),
          public_review_count = coalesce((pub->>'review_count')::int, public_review_count),
          public_updated_at = now(), updated_at = now()
          where user_id = p_user and store_id = v_store;
        v_public_dates := true;
      end if;
      for r in select value from jsonb_array_elements(coalesce(pub->'reviews','[]')) loop
        if r->>'external_id' !~ ('^I' || v_store || ':[0-9a-f]{8,64}$') then raise exception 'Invalid review identity'; end if;
        insert into public.reviews(user_id, source, external_id, title, rating, text, author, sentiment, review_date, visit_month, details)
        values(p_user, 'ikyu', r->>'external_id', '', (r->>'rating')::numeric, r->>'text', coalesce(r->>'author','匿名'), 'neutral', (r->>'review_date')::date, null,
          jsonb_build_object('textComplete', true, 'origin', 'public', 'storeId', v_store))
        on conflict(user_id, source, external_id) do update set rating = excluded.rating, text = excluded.text, author = excluded.author,
          review_date = excluded.review_date, details = excluded.details
        returning * into stored_review;
        if stored_review.text is distinct from r->>'text' or stored_review.rating is distinct from (r->>'rating')::numeric then raise exception 'Saved review mismatch'; end if;
        n_public := n_public + 1;
      end loop;
    end if;
  end loop;
  -- 公開評価: 全一休店舗の平均（小数2桁）と口コミ数合計を、日本時間の当日の snapshots(source='ikyu') へ（PR #11 と同じ規約）。
  if v_public_dates then
    insert into public.snapshots(user_id,source,date,rating,reviews)
      select p_user,'ikyu',(now() at time zone 'Asia/Tokyo')::date,round(avg(st.public_rating),2),sum(st.public_review_count)
      from public.ikyu_stores st where st.user_id=p_user and (st.public_rating is not null or st.public_review_count is not null)
      having count(*) > 0
      on conflict(user_id,source,date) do update set rating=coalesce(excluded.rating,snapshots.rating), reviews=coalesce(excluded.reviews,snapshots.reviews);
  end if;
  -- 全サイト共通のKPI・PV推移用に、全一休店舗の合計を snapshots(source='ikyu') へ反映（他の列は変更しない）。
  -- 日別PVはその日の行の pv、月別予約件数はその月1日の行の reservations（食べログと同じ規約）。
  insert into public.snapshots(user_id,source,date,pv)
    select p_user,'ikyu',p.date,sum(p.pv) from public.ikyu_daily_pageviews p
    where p.user_id=p_user and p.date = any(v_dates) group by p.date having count(p.pv) > 0
    on conflict(user_id,source,date) do update set pv=excluded.pv;
  insert into public.snapshots(user_id,source,date,reservations)
    select p_user,'ikyu',(p.month || '-01')::date,sum(p.reservations) from public.ikyu_monthly_pageviews p
    where p.user_id=p_user and p.month = any(v_months) group by p.month having count(p.reservations) > 0
    on conflict(user_id,source,date) do update set reservations=excluded.reservations;
  update public.ikyu_ingest_runs set stores=jsonb_array_length(p_stores), days=n_days, months=n_months, reviews=n_reviews, new_reviews=n_new where id=v_run;
  insert into public.sync_log(user_id,source,status,message) values(p_user,'ikyu',p_run->>'status',left(coalesce(p_run->>'message',''),500));
  return jsonb_build_object('run_id',v_run,'stores',jsonb_array_length(p_stores),'days',n_days,'months',n_months,'reviews',n_reviews,'new_reviews',n_new,'public_reviews',n_public);
end;
$$;
revoke all on function public.ingest_ikyu(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_ikyu(uuid,jsonb,jsonb) to service_role;
revoke all on function public.bump_credentials_version() from public, anon, authenticated;
