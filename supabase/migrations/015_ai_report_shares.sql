-- 015（014_ai_reports の後）: AI分析レポートを M-talk へ送った記録（ai_report_shares）。
-- 送信のたびに1行（送信者・レポート・送信先・日時・M-talk のメッセージID）。1時間あたりの送信回数の制限にも使う。
-- 書き込みは ai-analyst（JWT検証・レポートの所有者確認の後、本人の user_id に限定して service_role）だけ。
-- ブラウザ（authenticated）は本人の行の SELECT のみ（014 と同じ）。適用後に ai-analyst を配置する。

create table if not exists public.ai_report_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- レポートを削除しても送信の記録は残す（題名は送信時の値を保存）
  report_id uuid references public.ai_reports(id) on delete set null,
  report_title text not null check (length(btrim(report_title)) between 1 and 200),
  channel text not null default 'mtalk' check (channel = 'mtalk'),
  recipient_user_id uuid not null,
  recipient_name text not null check (length(btrim(recipient_name)) between 1 and 200),
  sender_label text not null check (length(btrim(sender_label)) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error text check (error is null or length(error) <= 300),
  mtalk_group_id bigint,
  mtalk_card_message_id bigint,
  mtalk_file_message_id bigint,
  pdf_bytes integer check (pdf_bytes is null or pdf_bytes >= 0),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists ai_report_shares_user_created on public.ai_report_shares(user_id, created_at desc);
create index if not exists ai_report_shares_report_created on public.ai_report_shares(report_id, created_at desc);

alter table public.ai_report_shares enable row level security;
drop policy if exists ai_report_shares_owner_read on public.ai_report_shares;
create policy ai_report_shares_owner_read on public.ai_report_shares for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.ai_report_shares from anon, authenticated;
grant select on public.ai_report_shares to authenticated;
