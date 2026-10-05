-- 023（022 の後）: 店舗ごとの週報の配信予定（weekly_delivery_schedules）。画面「自動取得の設定」の「週報の配信」で曜日・時刻を選ぶ。
-- アプリは設定の保存と表示だけを行う。予定時刻を過ぎた設定を見つけて週報を作り、M-talk の店舗Botのルームへ届けるのは
-- Grok Bot（agent-api POST /weekly/due → /weekly/claim → 週報を作成・公開・/weekly/deliver → /weekly/finish、service_role）だけ。
-- 次回予定（next_due_at）は supabase/functions/_shared/weekly-schedules.js（日本時間）で計算して保存する。
-- slot_at はその週の予定時刻（データ待ち・失敗でやり直しても週報の作成日 asOf は slot_at の日本時間の日付のまま）。
-- 既存の表・行は変更しない。適用後に review-api / agent-api を配置する（README「週報の配信」）。

create table if not exists public.weekly_delivery_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null,
  weekday smallint not null default 1 check (weekday between 0 and 6), -- 0=日曜 … 6=土曜（日本時間）
  time_of_day time not null default '10:13' check (extract(second from time_of_day) = 0), -- 日本時間
  enabled boolean not null default true,
  -- 送り先の M-talk ルーム（chat_groups.id）。null = 口コミ通知の設定 → 店舗Botの店舗ルーム の順で決める
  room_ids bigint[] check (room_ids is null or (cardinality(room_ids) between 1 and 20)),
  include_pdf boolean not null default false,
  next_due_at timestamptz,
  slot_at timestamptz,
  -- Grok Bot の作業中の印（他のエージェントと二重に作らない）。期限切れなら次の確認で取り直せる
  claim_id uuid,
  claim_expires_at timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 100),
  last_status text check (last_status is null or last_status in ('delivered', 'skipped', 'deferred', 'failed')),
  last_reason text check (last_reason is null or length(last_reason) <= 500),
  last_as_of date,
  last_html_url text check (last_html_url is null or (length(last_html_url) <= 300 and last_html_url ~ '^https://marugo-s\.github\.io/gourmet/weekly/')),
  last_card_message_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(last_card_message_ids) = 'array' and jsonb_array_length(last_card_message_ids) <= 20),
  last_finished_at timestamptz,
  last_delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint weekly_delivery_schedules_user_store unique (user_id, store_id),
  constraint weekly_delivery_schedules_store_fk foreign key (store_id, user_id) references public.stores(id, user_id) on delete cascade,
  -- 停止中は予定を持たない（配信されない）
  check (enabled or next_due_at is null)
);
-- エージェントの「予定時刻を過ぎた設定」の検索用
create index if not exists weekly_delivery_schedules_due on public.weekly_delivery_schedules(user_id, next_due_at) where enabled;

-- fetch_schedules と同じ方針: ブラウザは本人の行の SELECT のみ。
-- 書き込みは review-api（JWT検証後、本人の user_id に限定して service_role で保存）と agent-api（service_role）だけ。
alter table public.weekly_delivery_schedules enable row level security;
drop policy if exists weekly_delivery_schedules_owner_read on public.weekly_delivery_schedules;
create policy weekly_delivery_schedules_owner_read on public.weekly_delivery_schedules for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.weekly_delivery_schedules from anon, authenticated;
grant select on public.weekly_delivery_schedules to authenticated;
