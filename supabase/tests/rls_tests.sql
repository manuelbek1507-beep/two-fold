-- 2 Fold database security tests. NOT YET EXECUTED (no Postgres/Supabase was available when this was written).
-- Run against a LOCAL/DEV Supabase database only (never production):
--   supabase start && supabase db reset && psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -v ON_ERROR_STOP=1 -f supabase/tests/rls_tests.sql
-- Everything runs in one transaction that is rolled back. Inserting into auth.users may need extra NOT NULL
-- columns on some Supabase versions; adjust the INSERT below if so.
begin;

create or replace function pg_temp.as_user(uid uuid, mail text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'email', mail, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create or replace function pg_temp.back() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.expect_error(q text, why text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then return; end;
  raise exception 'FAIL (expected an error): %', why;
end $$;
create or replace function pg_temp.expect(cond boolean, why text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL: %', why; end if; end $$;

-- ---------- fixtures (as superuser)
insert into public.allowed_emails values ('a@t.test'), ('b@t.test'), ('c@t.test'), ('d@t.test'), ('e@t.test');
insert into auth.users (id, email, aud, role) values
 ('00000000-0000-0000-0000-00000000000a', 'a@t.test', 'authenticated', 'authenticated'),
 ('00000000-0000-0000-0000-00000000000b', 'b@t.test', 'authenticated', 'authenticated'),
 ('00000000-0000-0000-0000-00000000000c', 'c@t.test', 'authenticated', 'authenticated'),
 ('00000000-0000-0000-0000-00000000000d', 'd@t.test', 'authenticated', 'authenticated'),
 ('00000000-0000-0000-0000-00000000000e', 'e@t.test', 'authenticated', 'authenticated');
select pg_temp.expect_error($$insert into auth.users (id, email, aud, role) values (gen_random_uuid(), 'stranger@t.test', 'authenticated', 'authenticated')$$,
  'signup with a non-approved email must be rejected');

insert into public.couples(id) values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
insert into public.couple_members(couple_id, user_id) values
 ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a'),
 ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000b'),
 ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000000c'),
 ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000000d');
select pg_temp.expect_error($$insert into public.couple_members(couple_id, user_id) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000e')$$,
  'a third member must be rejected by the cap trigger');
select pg_temp.expect_error($$insert into public.couple_members(couple_id, user_id) values ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000000a')$$,
  'a user can belong to only one couple');

insert into public.devices(id, user_id, couple_id, label, public_key) values
 ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'a', '{"kty":"EC","crv":"P-256","x":"x","y":"y"}'),
 ('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', '22222222-2222-2222-2222-222222222222', 'c', '{"kty":"EC","crv":"P-256","x":"x","y":"y"}');
insert into public.messages(couple_id, sender_id, sender_device_id, client_id, ciphertext, iv) values
 ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', gen_random_uuid(), 'ct1', 'iv'),
 ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000000c', 'cccccccc-0000-0000-0000-000000000001', gen_random_uuid(), 'ct2', 'iv');

-- ---------- anon has nothing
set local role anon;
select pg_temp.expect_error('select count(*) from public.messages', 'anon must not read messages');
select pg_temp.expect_error('select count(*) from public.letters', 'anon must not read letters');
select pg_temp.expect_error($$select public.inbox_letters()$$, 'anon must not call inbox_letters');
reset role;

-- ---------- couple isolation
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'a@t.test');
select pg_temp.expect((select count(*) from public.messages) = 1, 'A sees exactly their own couple''s message');
select pg_temp.expect((select count(*) from public.messages where couple_id = '22222222-2222-2222-2222-222222222222') = 0, 'A cannot read couple 2 by id');
select pg_temp.expect((select count(*) from public.devices) = 1, 'A sees only their couple''s devices');
select pg_temp.expect_error($$insert into public.messages(couple_id, sender_id, sender_device_id, client_id, ciphertext, iv) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', gen_random_uuid(), 'x', 'y')$$,
  'direct INSERT into messages must be impossible (only send_message RPC)');
select pg_temp.expect_error($$select public.send_message(gen_random_uuid(), 'text', 'x', 'y', 'cccccccc-0000-0000-0000-000000000001', null, '[{"device_id":"cccccccc-0000-0000-0000-000000000001","wrapped_key":"k","iv":"i"}]'::jsonb)$$,
  'cannot send using another couple''s device');
update public.messages set ciphertext = 'tampered';   -- RLS: no UPDATE policy => silently 0 rows
select pg_temp.expect((select count(*) from public.messages where ciphertext = 'tampered') = 0, 'messages cannot be edited by clients');
select pg_temp.expect_error($$insert into public.memories(couple_id, created_by, media_path, media_type, mime, size_bytes) values ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222/00000000-0000-0000-0000-00000000000a/x.jpg', 'image', 'image/jpeg', 10)$$,
  'cannot add memories to another couple');
select pg_temp.expect_error($$insert into storage.objects(bucket_id, name, owner) values ('memories', '22222222-2222-2222-2222-222222222222/00000000-0000-0000-0000-00000000000a/x.jpg', '00000000-0000-0000-0000-00000000000a')$$,
  'cannot upload into another couple''s storage folder');
select pg_temp.expect_error($$insert into storage.objects(bucket_id, name, owner) values ('memories', '11111111-1111-1111-1111-111111111111/00000000-0000-0000-0000-00000000000b/x.jpg', '00000000-0000-0000-0000-00000000000a')$$,
  'cannot upload into the partner''s personal sub-folder');
select pg_temp.back();

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c', 'c@t.test');
select pg_temp.expect((select count(*) from public.messages) = 1 and (select ciphertext from public.messages) = 'ct2', 'C sees only couple 2 data');
select pg_temp.back();

-- ---------- unpaired user, invite brute force
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e', 'e@t.test');
select pg_temp.expect((select count(*) from public.messages) = 0, 'unpaired user sees nothing');
select pg_temp.expect(public.join_couple('WRONGCODE') = 'invalid', 'wrong invite code is rejected');
select public.join_couple('WRONG2'); select public.join_couple('WRONG3'); select public.join_couple('WRONG4'); select public.join_couple('WRONG5');
select pg_temp.expect(public.join_couple('WRONG6') = 'rate_limited', 'invite guessing is rate limited after 5 tries');
select pg_temp.back();

-- ---------- letters: server-enforced unlock and immutability after delivery
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'a@t.test');
insert into public.letters(id, couple_id, author_id, title, body, status, unlock_at)
values ('99999999-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a', 'hi', 'secret body', 'sent', now() + interval '1 day');
select pg_temp.back();
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'b@t.test');
select pg_temp.expect((select count(*) from public.letters) = 0, 'recipient cannot read letters table directly');
select pg_temp.expect((select body is null and is_locked from public.inbox_letters() limit 1), 'locked letter body is NOT returned to recipient');
select pg_temp.back();
update public.letters set unlock_at = now() - interval '1 minute' where id = '99999999-0000-0000-0000-000000000001';   -- time passes
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'b@t.test');
select pg_temp.expect((select body = 'secret body' and not is_locked from public.inbox_letters() limit 1), 'body appears once unlock time has passed (server clock)');
select public.mark_letter_read('99999999-0000-0000-0000-000000000001');
select pg_temp.expect((select read_at is not null from public.inbox_letters() limit 1), 'mark_letter_read works on a delivered letter');
select pg_temp.back();
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'a@t.test');
select pg_temp.expect_error($$update public.letters set body = 'changed' where id = '99999999-0000-0000-0000-000000000001'$$, 'a delivered letter cannot be edited');
delete from public.letters where id = '99999999-0000-0000-0000-000000000001';   -- RLS filters it out => 0 rows
select pg_temp.expect((select count(*) from public.letters where id = '99999999-0000-0000-0000-000000000001') = 1, 'a delivered letter cannot be deleted');
select pg_temp.back();

-- ---------- calls
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'a@t.test');
select public.start_call('voice');
select pg_temp.expect_error($$select public.start_call('voice')$$, 'second simultaneous call is refused');
select pg_temp.back();
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c', 'c@t.test');
select pg_temp.expect((select count(*) from public.calls) = 0, 'other couple cannot see calls');
select pg_temp.back();
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'b@t.test');
select pg_temp.expect((select count(*) from public.calls where state = 'ringing') = 1, 'callee sees the ringing call');
select public.end_call((select id from public.calls limit 1));
select pg_temp.expect((select end_reason = 'declined' from public.calls limit 1), 'callee ending a ringing call = declined');
select pg_temp.back();

select 'ALL RLS TESTS PASSED' as result;
rollback;
