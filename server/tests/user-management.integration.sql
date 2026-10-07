-- Run as postgres after migrations 025/026. Fixtures and mutations never commit.
begin;
select set_config('gourmet_test.admin', gen_random_uuid()::text, true),
       set_config('gourmet_test.viewer', gen_random_uuid()::text, true),
       set_config('gourmet_test.delete', gen_random_uuid()::text, true),
       set_config('gourmet_test.unconfirmed', gen_random_uuid()::text, true),
       set_config('gourmet_test.orphan', gen_random_uuid()::text, true),
       set_config('gourmet_test.a', gen_random_uuid()::text, true),
       set_config('gourmet_test.b', gen_random_uuid()::text, true),
       set_config('gourmet_test.own', gen_random_uuid()::text, true);

insert into auth.users(id, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
select current_setting('gourmet_test.' || k)::uuid,
  'gourmet-test-' || current_setting('gourmet_test.' || k) || '@example.invalid',
  case when k = 'unconfirmed' then null else now() end, now(), now(),
  '{"role":"admin","is_admin":true}'::jsonb
from unnest(array['admin','viewer','delete','unconfirmed','orphan']) as x(k);
insert into public.source_reviews(user_id,source,store_key,external_id,text)
values(current_setting('gourmet_test.orphan')::uuid,'google','unmapped','fixture-review','fixture only');
insert into public.gourmet_admin_users(user_id) values(current_setting('gourmet_test.admin')::uuid);
insert into public.stores(id,user_id,name)
select current_setting('gourmet_test.' || k)::uuid,
  current_setting('gourmet_test.' || case when k='own' then 'viewer' else 'admin' end)::uuid,
  'Gourmet ACL test ' || k
from unnest(array['a','b','own']) as x(k);
insert into public.store_sites(user_id,store_id,source,site_store_key)
select user_id,id,'google',replace(id::text,'-','') from public.stores
where id in (current_setting('gourmet_test.a')::uuid,current_setting('gourmet_test.b')::uuid,current_setting('gourmet_test.own')::uuid);
insert into public.source_daily_metrics(user_id,source,store_key,date,pv)
select user_id,source,site_store_key,current_date,
  case when store_id=current_setting('gourmet_test.a')::uuid then 111 else 222 end
from public.store_sites where store_id in (current_setting('gourmet_test.a')::uuid,current_setting('gourmet_test.b')::uuid,current_setting('gourmet_test.own')::uuid);

-- All assertions below use real authenticated privileges, not postgres RLS bypass.
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.viewer'),true);
set local role authenticated;
do $$ begin
  if public.gourmet_is_admin() or public.gourmet_can_view() or public.gourmet_my_access()->>'status'<>'pending' then raise exception 'pending/metadata escalation'; end if;
  if exists(select 1 from public.stores) or exists(select 1 from public.source_daily_metrics) then raise exception 'pending owner reads'; end if;
  begin perform public.gourmet_list_users(); raise exception 'list allowed'; exception when sqlstate 'P0403' then null; end;
  begin perform public.gourmet_set_admin(auth.uid(),true); raise exception 'self promotion'; exception when sqlstate 'P0403' then null; end;
  begin perform public.gourmet_set_access(auth.uid(),'approved',array[current_setting('gourmet_test.a')::uuid]); raise exception 'self approval'; exception when sqlstate 'P0403' then null; end;
  begin perform public.gourmet_delete_user(current_setting('gourmet_test.delete')::uuid,'x'); raise exception 'viewer deletion'; exception when sqlstate 'P0403' then null; end;
  begin insert into public.gourmet_admin_users(user_id) values(auth.uid()); raise exception 'direct role write'; exception when insufficient_privilege then null; end;
  begin insert into public.gourmet_user_access(user_id,status) values(auth.uid(),'approved'); raise exception 'direct approval'; exception when insufficient_privilege then null; end;
  begin insert into public.gourmet_store_access(user_id,store_id) values(auth.uid(),current_setting('gourmet_test.a')::uuid); raise exception 'direct ACL'; exception when insufficient_privilege then null; end;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('gourmet_test.admin'),true);
set local role authenticated;
do $$ declare result jsonb; begin
  if not public.gourmet_is_admin() or not public.gourmet_can_view() then raise exception 'admin access'; end if;
  result := public.gourmet_list_users();
  if not exists(select 1 from jsonb_array_elements(result->'users') u where u->>'id'=current_setting('gourmet_test.viewer')) then raise exception 'list missing fixture'; end if;
  if exists(select 1 from jsonb_array_elements(result->'users') u where u ? 'encrypted_password' or u ? 'raw_user_meta_data') then raise exception 'secret exposure'; end if;
  begin perform public.gourmet_set_admin(auth.uid(),false); raise exception 'self demotion'; exception when sqlstate 'P0409' then null; end;
  begin perform public.gourmet_set_access(auth.uid(),'revoked'); raise exception 'admin stop'; exception when sqlstate 'P0409' then null; end;
  begin perform public.gourmet_set_access(current_setting('gourmet_test.viewer')::uuid,'approved'); raise exception 'empty stores'; exception when sqlstate 'P0400' then null; end;
  begin perform public.gourmet_set_access(current_setting('gourmet_test.viewer')::uuid,'approved',array[gen_random_uuid()]); raise exception 'invalid stores'; exception when sqlstate 'P0400' then null; end;
  begin perform public.gourmet_set_admin(current_setting('gourmet_test.unconfirmed')::uuid,true); raise exception 'unconfirmed admin'; exception when sqlstate 'P0409' then null; end;
  begin perform public.gourmet_set_access(current_setting('gourmet_test.unconfirmed')::uuid,'approved',array[current_setting('gourmet_test.a')::uuid]); raise exception 'unconfirmed approval'; exception when sqlstate 'P0409' then null; end;
  perform public.gourmet_set_access(current_setting('gourmet_test.viewer')::uuid,'approved',array[current_setting('gourmet_test.a')::uuid]);
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('gourmet_test.viewer'),true);
set local role authenticated;
do $$ begin
  if public.gourmet_is_admin() or not public.gourmet_can_view() then raise exception 'approved access'; end if;
  if (select count(*) from public.stores)<>1 or not exists(select 1 from public.stores where id=current_setting('gourmet_test.a')::uuid) then raise exception 'store boundary'; end if;
  if (select count(*) from public.store_sites)<>1 or (select sum(pv) from public.source_daily_metrics)<>111 then raise exception 'metric boundary'; end if;
  if exists(select 1 from public.snapshots) or exists(select 1 from public.credentials) then raise exception 'legacy/settings leak'; end if;
  begin perform public.gourmet_list_users(); raise exception 'approved list'; exception when sqlstate 'P0403' then null; end;
  begin delete from public.stores; if found then raise exception 'viewer delete'; end if; exception when insufficient_privilege then null; end;
  begin update public.stores set name='changed'; if found then raise exception 'viewer update'; end if; exception when insufficient_privilege then null; end;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('gourmet_test.admin'),true);
set local role authenticated;
select public.gourmet_set_access(current_setting('gourmet_test.viewer')::uuid,'approved',array[current_setting('gourmet_test.b')::uuid]);
reset role;
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.viewer'),true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.stores)<>1 or not exists(select 1 from public.stores where id=current_setting('gourmet_test.b')::uuid) or (select sum(pv) from public.source_daily_metrics)<>222 then raise exception 'ACL replacement'; end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('gourmet_test.admin'),true);
set local role authenticated;
select public.gourmet_set_access(current_setting('gourmet_test.viewer')::uuid,'revoked');
reset role;
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.viewer'),true);
set local role authenticated;
do $$ begin
  if public.gourmet_can_view() or public.gourmet_my_access()->>'status'<>'revoked' or exists(select 1 from public.stores) or exists(select 1 from public.source_daily_metrics) then raise exception 'revocation stale session'; end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('gourmet_test.admin'),true);
set local role authenticated;
select public.gourmet_set_admin(current_setting('gourmet_test.viewer')::uuid,true);
reset role;
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.viewer'),true);
set local role authenticated;
do $$ begin
  if not public.gourmet_is_admin() or (select count(*) from public.stores where id in (current_setting('gourmet_test.a')::uuid,current_setting('gourmet_test.b')::uuid,current_setting('gourmet_test.own')::uuid))<>3 then raise exception 'promotion global read'; end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub',current_setting('gourmet_test.admin'),true);
set local role authenticated;
do $$ begin
  begin perform public.gourmet_delete_user(auth.uid(),'gourmet-test-'||auth.uid()||'@example.invalid'); raise exception 'admin delete'; exception when sqlstate 'P0409' then null; end;
  perform public.gourmet_set_admin(current_setting('gourmet_test.viewer')::uuid,false);
  begin perform public.gourmet_delete_user(current_setting('gourmet_test.viewer')::uuid,'gourmet-test-'||current_setting('gourmet_test.viewer')||'@example.invalid'); raise exception 'owner deletion'; exception when sqlstate 'P0409' then null; end;
  begin perform public.gourmet_delete_user(current_setting('gourmet_test.orphan')::uuid,'gourmet-test-'||current_setting('gourmet_test.orphan')||'@example.invalid'); raise exception 'orphan review deletion'; exception when sqlstate 'P0409' then null; end;
  begin perform public.gourmet_delete_user(current_setting('gourmet_test.delete')::uuid,'wrong@example.invalid'); raise exception 'wrong confirmation'; exception when sqlstate 'P0400' then null; end;
  perform public.gourmet_delete_user(current_setting('gourmet_test.delete')::uuid,'gourmet-test-'||current_setting('gourmet_test.delete')||'@example.invalid');
end $$;
reset role;
do $$ begin
  if exists(select 1 from auth.users where id=current_setting('gourmet_test.delete')::uuid) then raise exception 'deletion not persisted'; end if;
  if not exists(select 1 from public.gourmet_role_audit where kind='delete' and target_user_id is null and target_email='gourmet-test-'||current_setting('gourmet_test.delete')||'@example.invalid') then raise exception 'deletion audit lost'; end if;
end $$;

-- A demoted administrator cannot use old identity claims to promote/delete.
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.viewer'),true);
set local role authenticated;
do $$ begin
  if public.gourmet_is_admin() or public.gourmet_can_view() then raise exception 'demotion not immediate'; end if;
  begin perform public.gourmet_set_admin(auth.uid(),true); raise exception 'demoted promote'; exception when sqlstate 'P0403' then null; end;
end $$;
reset role;
rollback;
select 'PASS: pending, metadata forgery, admin-only RPC, assigned stores/metrics, replacement, revocation, promotion/demotion, protected deletion and audit; all fixtures rolled back' as result;
