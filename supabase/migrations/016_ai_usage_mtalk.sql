-- 016（015_ai_report_shares の後）: M-talk の「AI分析」Bot への質問（ai-analyst POST /mtalk-chat）の利用記録。
-- ai_usage に kind = 'mtalk' と、質問した M-talk 利用者（line_report の chat_users.id）を足す。1時間あたりの回数制限は mtalk_user_id ごと。
-- user_id は読み込んだデータの持ち主（gourmet 利用者）。既存の行は変更しない。書き込みは ai-analyst（service_role）だけ。適用後に ai-analyst を配置する。
alter table public.ai_usage add column if not exists mtalk_user_id uuid;
alter table public.ai_usage drop constraint if exists ai_usage_kind_check;
alter table public.ai_usage add constraint ai_usage_kind_check check (kind in ('ask','report','mtalk'));
alter table public.ai_usage drop constraint if exists ai_usage_mtalk_user_check;
alter table public.ai_usage add constraint ai_usage_mtalk_user_check check ((kind = 'mtalk') = (mtalk_user_id is not null));
create index if not exists ai_usage_mtalk_created on public.ai_usage(mtalk_user_id, created_at desc) where kind = 'mtalk';
