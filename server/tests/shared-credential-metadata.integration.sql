-- Run as postgres after 027. Only isolated fixtures; every change rolls back.
begin;
select set_config('gourmet_test.metadata_owner',gen_random_uuid()::text,true),
       set_config('gourmet_test.metadata_admin',gen_random_uuid()::text,true),
       set_config('gourmet_test.metadata_viewer',gen_random_uuid()::text,true);
insert into auth.users(id,email,email_confirmed_at,created_at,updated_at)
select current_setting('gourmet_test.metadata_'||k)::uuid,
 'metadata-'||current_setting('gourmet_test.metadata_'||k)||'@example.invalid',now(),now(),now()
from unnest(array['owner','admin','viewer']) x(k);
insert into public.gourmet_admin_users(user_id)
select current_setting('gourmet_test.metadata_'||k)::uuid from unnest(array['owner','admin']) x(k);
insert into public.gourmet_user_access(user_id,status)
values(current_setting('gourmet_test.metadata_viewer')::uuid,'approved');
insert into public.credentials(user_id,source,store_key,label,username,password_enc)
select current_setting('gourmet_test.metadata_owner')::uuid,source,key,'metadata-fixture','fixture-only','fixture-only'
from (values('tabelog',''),('ikyu','112789')) x(source,key);
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.metadata_admin'),true);
set local role authenticated;
do $$ begin
 if not public.gourmet_is_admin() then raise exception 'admin not active'; end if;
 if (select count(id) from public.credentials where user_id=current_setting('gourmet_test.metadata_owner')::uuid)<>2 then raise exception 'shared credentials missing'; end if;
 if not exists(select source from public.credentials where user_id=current_setting('gourmet_test.metadata_owner')::uuid and source='tabelog') then raise exception 'tabelog unregistered'; end if;
 if not exists(select source from public.credentials where user_id=current_setting('gourmet_test.metadata_owner')::uuid and source='ikyu' and store_key='112789') then raise exception 'ikyu unregistered'; end if;
 begin perform username from public.credentials; raise exception 'login exposed'; exception when insufficient_privilege then null; end;
 begin perform password_enc from public.credentials; raise exception 'password exposed'; exception when insufficient_privilege then null; end;
 begin update public.credentials set label='changed' where user_id=current_setting('gourmet_test.metadata_owner')::uuid; if found then raise exception 'cross-owner write'; end if; exception when insufficient_privilege then null; end;
 begin delete from public.credentials where user_id=current_setting('gourmet_test.metadata_owner')::uuid; if found then raise exception 'cross-owner delete'; end if; exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.metadata_viewer'),true);
set local role authenticated;
do $$ begin
 if exists(select id from public.credentials) then raise exception 'viewer metadata leak'; end if;
end $$;
reset role;
delete from public.gourmet_admin_users where user_id=current_setting('gourmet_test.metadata_admin')::uuid;
select set_config('request.jwt.claim.sub',current_setting('gourmet_test.metadata_admin'),true);
set local role authenticated;
do $$ begin
 if exists(select id from public.credentials) then raise exception 'demoted admin stale access'; end if;
end $$;
reset role;
rollback;
select 'PASS: shared registration status, secret columns blocked, owner writes preserved, viewer denied, demotion immediate; fixtures rolled back' as result;
