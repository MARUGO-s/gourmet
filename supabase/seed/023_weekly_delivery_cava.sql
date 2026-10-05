-- 023 の初期データ（任意・何度実行しても同じ結果）。migration 023_weekly_delivery_schedules.sql の適用後に、SQLエディタまたは psql で1回実行する。
-- 画面「自動取得の設定」→「週報の配信」で同じ設定を保存してもよい（そのほうが推奨。SQL は画面を使えないときの代わり）。
-- 対象: 店舗 BISTRO CAVACAVA（stores.id = 89831708-aeac-4d1d-a345-8b345579a27f）を持つ利用者だけ。他の店舗・行は変更しない。
--
-- A) 週報の配信: 毎週 月曜 10:13（日本時間）・送り先 M-talk ルーム 30（BistroCAVACAVA）・PDF なし・有効。
--    次回予定は「今より後で最初の月曜 10:13（日本時間）」。2026-10-05 分はすでに配信済み（カード 974）なので 2026-10-12 になる。
--    既に設定がある場合は曜日・時刻・ルームだけ上書きし、前回の配信の記録は残す。
begin;

with target as (
  select s.id as store_id, s.user_id from public.stores s where s.id = '89831708-aeac-4d1d-a345-8b345579a27f'
), jst as (
  select (now() at time zone 'Asia/Tokyo') as t
), slot as (
  select case when c <= t then c + interval '7 days' else c end as local_slot
  from (select t, date_trunc('day', t) + ((1 - extract(isodow from t)::int + 7) % 7) * interval '1 day' + time '10:13' as c from jst) x
)
insert into public.weekly_delivery_schedules (user_id, store_id, weekday, time_of_day, enabled, room_ids, include_pdf, next_due_at, slot_at, attempts, updated_at)
select target.user_id, target.store_id, 1, '10:13', true, array[30]::bigint[], false,
       slot.local_slot at time zone 'Asia/Tokyo', slot.local_slot at time zone 'Asia/Tokyo', 0, now()
from target, slot
on conflict (user_id, store_id) do update set
  weekday = excluded.weekday, time_of_day = excluded.time_of_day, enabled = true, room_ids = excluded.room_ids,
  include_pdf = excluded.include_pdf, next_due_at = excluded.next_due_at, slot_at = excluded.slot_at,
  claim_id = null, claim_expires_at = null, attempts = 0, updated_at = now();

-- B) 任意: 口コミ通知も含めて、この店舗の M-talk の送り先を「Bistro CAVACAVA bot・ルーム 30 だけ」にする（review_alert_settings）。
--    ※ 新着口コミ・総合点の変化の通知も ルーム 30 だけに届くようになる（今は Bot が参加している全グループ）。
--    週報だけなら A で十分（週報は A の room_ids を口コミ通知の設定より先に使う）。必要なときだけ、次の文の行頭の "-- " を外して実行する。
-- insert into public.review_alert_settings (user_id, store_id, mtalk_bot_mode, mtalk_bot_id, mtalk_bot_name, mtalk_room_ids, updated_at)
-- select s.user_id, s.id, 'manual', '285666af-5fbb-43a9-88e2-998740b0e042', 'Bistro CAVACAVA bot', array[30]::bigint[], now()
-- from public.stores s where s.id = '89831708-aeac-4d1d-a345-8b345579a27f'
-- on conflict (user_id, store_id) do update set
--   mtalk_bot_mode = excluded.mtalk_bot_mode, mtalk_bot_id = excluded.mtalk_bot_id, mtalk_bot_name = excluded.mtalk_bot_name,
--   mtalk_room_ids = excluded.mtalk_room_ids, updated_at = now();

commit;

-- 確認
select w.store_id, st.name, w.weekday, w.time_of_day, w.room_ids, w.enabled,
       w.next_due_at at time zone 'Asia/Tokyo' as next_due_jst
from public.weekly_delivery_schedules w join public.stores st on st.id = w.store_id
where w.store_id = '89831708-aeac-4d1d-a345-8b345579a27f';
