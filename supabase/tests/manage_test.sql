-- Checks for supabase/setup.sql: who can see and
-- change what, ordering of connections, suggestions and "connect everyone".
-- Run against a test database with setup.sql applied and two confirmed users
-- in auth.users: 1111… admin@example.com (put in ce_admins) and 2222… member@example.com.
-- Any failed check raises an error. Rolls back at the end.
begin;

-- Admin (admin@example.com is in ce_admins).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
do $$
declare e_pub uuid; e_draft uuid; a uuid; b uuid; c uuid; d uuid; n int; r record;
begin
  assert public.ce_is_admin(), 'admin is admin';
  insert into ce_events (title, starts_at, published) values ('Opening Salon', now() - interval '30 days', true) returning id into e_pub;
  insert into ce_events (title, starts_at) values ('Secret Draft', now() + interval '30 days') returning id into e_draft;
  insert into ce_people (first_name, email, disciplines, tags, notes) values ('Ada', 'ada@example.com', '{design}', '{founder}', 'private note') returning id into a;
  insert into ce_people (first_name, disciplines) values ('Ben', '{Design}') returning id into b;
  insert into ce_people (first_name) values ('Cy') returning id into c;
  insert into ce_people (first_name) values ('Dee') returning id into d;
  insert into ce_event_people (event_id, person_id, role) values (e_pub, a, 'host'), (e_pub, c, 'attendee'), (e_pub, d, 'attendee');

  -- Suggestions for Ada: Cy and Dee share the event (3), Ben shares "design" (1).
  select count(*) into n from ce_connection_suggestions(a);
  assert n = 3, 'three suggestions, got ' || n;
  select * into r from ce_connection_suggestions(a) limit 1;
  assert r.score = 3 and r.shared_events = 1, 'event-mates first';
  select * into r from ce_connection_suggestions(a) where person_id = b;
  assert r.score = 1 and r.shared_interests = '{design}', 'shared discipline, any case';

  -- Connections are stored in order, either way round, once per kind.
  insert into ce_connections (person_a, person_b, kind) values (greatest(a, b), least(a, b), 'collaborated');
  assert (select person_a < person_b from ce_connections where kind = 'collaborated'), 'pair ordered';
  begin
    insert into ce_connections (person_a, person_b, kind) values (least(a, b), greatest(a, b), 'collaborated');
    assert false, 'duplicate connection allowed';
  exception when unique_violation then null;
  end;
  begin
    insert into ce_connections (person_a, person_b) values (a, a);
    assert false, 'self connection allowed';
  exception when raise_exception then null;
  end;
  assert not exists (select 1 from ce_connection_suggestions(a) where person_id = b), 'connected people are not suggested';

  -- Connect everyone at the event: Ada–Cy, Ada–Dee, Cy–Dee; again makes none.
  assert ce_connect_event(e_pub) = 3, 'three new connections';
  assert ce_connect_event(e_pub) = 0, 'no duplicates on a second run';
  assert (select count(*) from ce_connection_suggestions(a)) = 0, 'nothing left to suggest';

  -- Deleting a person removes their attendance and connections.
  delete from ce_people where id = d;
  assert (select count(*) from ce_connections where d in (person_a, person_b)) = 0, 'connections cascade';

  -- Admins: add by email, can't remove yourself.
  assert (ce_add_admin(' MEMBER@example.com ')).email = 'member@example.com', 'add admin by email, any case';
  assert ce_remove_admin('member@example.com'), 'remove admin';
  begin
    perform ce_remove_admin('admin@example.com');
    assert false, 'removed yourself';
  exception when invalid_parameter_value then null;
  end;

  -- Every event gets a stable, unique web address.
  assert (select slug from ce_events where id = e_pub) ~ '^opening-salon-\d{4}-\d{2}-\d{2}$', 'slug from title and date';
  insert into ce_events (title, starts_at) select title, starts_at from ce_events where id = e_pub;
  assert (select count(distinct slug) from ce_events where title = 'Opening Salon') = 2, 'slugs unique';
  update ce_events set title = 'Renamed Salon' where id = e_pub;
  assert (select slug from ce_events where id = e_pub) like 'opening-salon-%', 'slug kept when renamed';
  update ce_events set title = 'Opening Salon' where id = e_pub;

  insert into ce_partners (name, published) values ('Public Partner', true), ('Hidden Partner', false);
  insert into ce_site_content (key, value) values ('home.lede', 'A think tank for creatives.');
  begin
    insert into ce_events (title, starts_at, link) values ('Bad link', now(), 'javascript:alert(1)');
    assert false, 'non-http link allowed';
  exception when check_violation then null;
  end;
end $$;

-- Non-admin, signed in: sees only what the public sees, changes nothing.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
do $$
declare n int;
begin
  assert not public.ce_is_admin(), 'member is not admin';
  assert (select count(*) from ce_events) = 1, 'member sees published events only';
  assert (select count(*) from ce_people) = 0, 'member sees no people';
  assert (select count(*) from ce_connections) = 0, 'member sees no connections';
  assert (select count(*) from ce_event_people) = 0, 'member sees no attendance';
  assert (select count(*) from ce_admins) = 0, 'member sees no admins';
  assert (select count(*) from ce_partners) = 1, 'member sees published partners only';
  begin
    insert into ce_events (title, starts_at) values ('Sneaky', now());
    assert false, 'member inserted an event';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into ce_admins (email) values ('member@example.com');
    assert false, 'member made themselves admin';
  exception when insufficient_privilege then null;
  end;
  update ce_site_content set value = 'defaced';
  get diagnostics n = row_count;
  assert n = 0, 'member changed site text';
  begin
    perform ce_add_admin('member@example.com');
    assert false, 'member added an admin';
  exception when insufficient_privilege then null;
  end;
  begin
    perform ce_connection_suggestions(gen_random_uuid());
    assert false, 'member ran suggestions';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Anonymous visitor.
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  assert (select count(*) from ce_events) = 1, 'public sees published events only';
  assert (select title from ce_events) = 'Opening Salon', 'not the draft';
  assert (select count(*) from ce_partners) = 1, 'public sees published partners only';
  assert (select value from ce_site_content where key = 'home.lede') = 'A think tank for creatives.', 'public reads site text';
  begin
    perform 1 from ce_people;
    assert false, 'public read people';
  exception when insufficient_privilege then null;
  end;
  begin
    perform ce_connect_event(gen_random_uuid());
    assert false, 'public ran connect';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
\echo 'All manage checks passed'
