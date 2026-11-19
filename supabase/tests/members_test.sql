-- Checks for members and introductions in supabase/setup.sql (section 5), plus
-- admins by confirmed email. Creates its own test accounts and rolls back.
-- Run against a test database with setup.sql applied (see README → Tests).
\set ON_ERROR_STOP 1
begin;
-- Accounts: admin (confirmed), squatter on an admin email (unconfirmed), members A,B,C (confirmed), non-member.
insert into auth.users values
 ('11111111-1111-1111-1111-111111111111','DillonLaurentW@gmail.com', now()),
 ('22222222-2222-2222-2222-222222222222','new-admin@example.com', null),
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ana@example.com', now()),
 ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','ben@example.com', now()),
 ('cccccccc-cccc-cccc-cccc-cccccccccccc','cy@example.com', now()),
 ('dddddddd-dddd-dddd-dddd-dddddddddddd','stranger@example.com', now());
create function pg_temp.as_user(u text) returns void language sql as $$
  select set_config('role', case when u is null then 'anon' else 'authenticated' end, true),
         set_config('request.jwt.claims', coalesce(json_build_object('sub',u,'role','authenticated')::text,''), true) $$;
do $$ begin
  -- anon: not admin, can read public tables, not people
  perform pg_temp.as_user(null);
  assert not public.ce_is_admin(), 'anon not admin';
  -- admin by email, case-insensitive
  perform pg_temp.as_user('11111111-1111-1111-1111-111111111111');
  assert public.ce_is_admin(), 'listed email is admin';
  perform public.ce_add_admin(' New-Admin@Example.com ');
  -- unconfirmed account on a listed email is NOT admin
  perform pg_temp.as_user('22222222-2222-2222-2222-222222222222');
  assert not public.ce_is_admin(), 'unconfirmed email is not admin';
end $$;
-- admin sets up people & connections: Ana–Ben, Ben–Cy (Cy is 2nd degree for Ana)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into ce_people (id, first_name, last_name, email, headline, city, notes) values
 ('a0000000-0000-0000-0000-00000000000a','Ana','Diaz','Ana@Example.com','Designer','Paris','secret'),
 ('b0000000-0000-0000-0000-00000000000b','Ben','Lee','ben@example.com',null,null,null),
 ('c0000000-0000-0000-0000-00000000000c','Cy','Ruiz','cy@example.com','Founder','Milan',null),
 ('e0000000-0000-0000-0000-00000000000e','Eve','NoAccount','eve@example.com',null,null,null);
insert into ce_connections (person_a, person_b) values
 ('b0000000-0000-0000-0000-00000000000b','a0000000-0000-0000-0000-00000000000a'),
 ('b0000000-0000-0000-0000-00000000000b','c0000000-0000-0000-0000-00000000000c'),
 ('b0000000-0000-0000-0000-00000000000b','e0000000-0000-0000-0000-00000000000e');
do $$ declare n int; r record; rid uuid; st text; begin
  -- admin can't remove self
  begin perform public.ce_remove_admin('dillonlaurentw@gmail.com'); assert false, 'removed self'; exception when sqlstate '22023' then null; end;
  -- stranger: not a member, sees nothing, can't read people
  perform pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd');
  select * into r from public.ce_me(); assert r.person_id is null and not r.is_admin, 'stranger me';
  select count(*) into n from public.ce_intro_suggestions(); assert n = 0, 'stranger no suggestions';
  begin perform count(*) from ce_people; select count(*) into n from ce_people; assert n = 0, 'stranger reads 0 people'; exception when insufficient_privilege then null; end;
  begin perform public.ce_request_intro('c0000000-0000-0000-0000-00000000000c','b0000000-0000-0000-0000-00000000000b','I would really like to meet you please'); assert false; exception when sqlstate '42501' then null; end;
  -- Ana: member; suggestion is Cy via Ben (Eve has no account so isn't shown)
  perform pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  select * into r from public.ce_me(); assert r.first_name = 'Ana', 'ana me';
  select count(*) into n from public.ce_intro_suggestions(); assert n = 1, 'one suggestion, got ' || n;
  select * into r from public.ce_intro_suggestions(); assert r.first_name = 'Cy' and r.connectors->0->>'first_name' = 'Ben' and r.open_request_status is null, 'cy via ben';
  begin perform public.ce_request_intro('c0000000-0000-0000-0000-00000000000c','b0000000-0000-0000-0000-00000000000b','too short'); assert false; exception when sqlstate '22023' then null; end;
  rid := public.ce_request_intro('c0000000-0000-0000-0000-00000000000c','b0000000-0000-0000-0000-00000000000b','Advice on pricing my first collection, please.');
  begin perform public.ce_request_intro('c0000000-0000-0000-0000-00000000000c','b0000000-0000-0000-0000-00000000000b','Advice on pricing my first collection, please.'); assert false; exception when sqlstate '23505' then null; end;
  select open_request_status into st from public.ce_intro_suggestions(); assert st = 'pending', 'shows requested';
  -- Cy can't see it yet
  perform pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');
  select count(*) into n from public.ce_my_intros(); assert n = 0, 'target hidden until introduced';
  begin perform public.ce_respond_intro(rid,'accept'); assert false; exception when others then null; end;
  -- Ben introduces with a note
  perform pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  select role, status into r from public.ce_my_intros(); assert r.role = 'connector' and r.status = 'pending', 'ben sees pending';
  assert public.ce_respond_intro(rid,'introduce','Ana is lovely.') = 'introduced', 'introduced';
  -- Cy sees it and accepts -> connected
  perform pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');
  select * into r from public.ce_my_intros(); assert r.role = 'target' and r.connector_note = 'Ana is lovely.' and r.requester->>'headline' = 'Designer', 'cy sees intro';
  assert public.ce_respond_intro(rid,'accept') = 'accepted', 'accepted';
  begin perform public.ce_respond_intro(rid,'decline'); assert false; exception when sqlstate '22023' then null; end;
  -- Ana now connected to Cy: no suggestions left
  perform pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  select count(*) into n from public.ce_intro_suggestions(); assert n = 0, 'connected, no suggestion';
  select status into st from public.ce_my_intros(); assert st = 'accepted', 'ana sees accepted';
  -- decline path hides who passed
  perform pg_temp.as_user('11111111-1111-1111-1111-111111111111');
  delete from ce_connections where kind = 'introduced';
  perform pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  rid := public.ce_request_intro('c0000000-0000-0000-0000-00000000000c','b0000000-0000-0000-0000-00000000000b','A second try at meeting you, thank you.');
  perform pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert public.ce_respond_intro(rid,'decline') = 'declined_by_connector', 'ben passes';
  perform pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  select status into st from public.ce_my_intros() where id = rid; assert st = 'declined', 'neutral decline';
  -- anon can't call member functions
  perform pg_temp.as_user(null);
  begin perform public.ce_my_intros(); assert false, 'anon called'; exception when insufficient_privilege then null; end;
  raise notice 'ALL RULE CHECKS PASSED';
end $$;
rollback;
