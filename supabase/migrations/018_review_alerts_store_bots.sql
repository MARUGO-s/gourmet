-- 口コミ通知の送り先を「M-talk の店舗Bot（店舗と同じ名前）が参加しているグループのルーム」に変更する。
-- 店舗ごとに Bot を 自動（名前で判定）／指定／送らない から選び、ルームを選べる（未選択＝Bot が参加している全グループ。1対1は除く）。
-- 個人宛て（recipients）の列は互換のため残すが、送信には使わない。既存の行・イベントは変更しない。

alter table public.review_alert_settings
  add column if not exists mtalk_bot_mode text not null default 'auto',
  add column if not exists mtalk_bot_id uuid,
  add column if not exists mtalk_bot_name text,
  add column if not exists mtalk_room_ids bigint[];

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'review_alert_settings_bot_mode') then
    alter table public.review_alert_settings
      add constraint review_alert_settings_bot_mode check (mtalk_bot_mode in ('auto', 'manual', 'none')),
      add constraint review_alert_settings_bot_manual check (mtalk_bot_mode <> 'manual' or mtalk_bot_id is not null),
      add constraint review_alert_settings_bot_name check (mtalk_bot_name is null or length(mtalk_bot_name) <= 100),
      add constraint review_alert_settings_rooms check (mtalk_room_ids is null or (cardinality(mtalk_room_ids) between 1 and 20));
  end if;
end $$;

comment on column public.review_alert_settings.mtalk_bot_mode is
  'auto = 店舗名で M-talk の店舗Botを判定 / manual = mtalk_bot_id の Bot / none = 送らない（未設定）';
comment on column public.review_alert_settings.mtalk_room_ids is
  'M-talk の chat_groups.id（Bot が参加しているグループのうち送るもの）。null = 参加している全グループ（1対1・ゴミ箱は除く）';
comment on column public.review_alert_settings.recipients is
  '旧: 個人宛ての送信先（互換のため残す。送信には使わない）';

-- 送信の記録: 店舗Botへの送信は target = 'bot'（recipient_user_id = Bot の id）、ルームごとの結果は rooms
alter table public.review_alert_deliveries
  add column if not exists target text not null default 'user',
  add column if not exists rooms jsonb not null default '[]'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'review_alert_deliveries_target') then
    alter table public.review_alert_deliveries
      add constraint review_alert_deliveries_target check (target in ('user', 'bot')),
      add constraint review_alert_deliveries_rooms check (jsonb_typeof(rooms) = 'array' and jsonb_array_length(rooms) <= 50);
  end if;
end $$;
