-- Creative Endeavors: everything the website keeps in its database.
--
-- How to use: in your Supabase project, open SQL Editor, paste in this whole
-- file and press Run. It's safe to run again at any time (it never deletes
-- your data), so run it again whenever this file changes.
--
-- What's in here, in order:
--   1. Admins: who can use /manage/. Put your email in the list just below.
--   2. Events, people, who came to what, and connections between people.
--   3. Partners and the words on the website.
--   4. Who can see and change what.
--   5. Members and introductions (/sign-in/ and /introductions/).
--   6. Photo storage.
--
-- Everything is a table starting with ce_ (Creative Endeavors).

create extension if not exists pgcrypto;

-- 1. Admins ----------------------------------------------------------------------

-- Admins are a list of email addresses. Whoever signs in with one of these
-- emails (after confirming it) can use /manage/. Add more here, or from
-- /manage/ → Admins once you're in.
create table if not exists public.ce_admins (
  email      text primary key check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz not null default now()
);

insert into public.ce_admins (email) values
  ('dillonlaurentw@gmail.com')
on conflict (email) do nothing;

-- The signed-in person's email, but only once they've confirmed it, so no one
-- can claim an admin's or a member's address by signing up with it.
create or replace function public.ce_my_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;

-- True when the signed-in person is an admin.
create or replace function public.ce_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.ce_admins where email = public.ce_my_email());
$$;

-- Keeps updated_at current on edit.
create or replace function public.ce_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 2. Events ----------------------------------------------------------------------

create table if not exists public.ce_events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) between 1 and 200),
  -- dinner, salon, workshop, talk, studio visit, opening, meetup, …
  kind        text check (kind is null or length(kind) <= 60),
  starts_at   timestamptz not null,
  ends_at     timestamptz check (ends_at is null or ends_at >= starts_at),
  venue       text check (venue is null or length(venue) <= 200),
  city        text check (city is null or length(city) <= 100),
  description text check (description is null or length(description) <= 4000),
  link        text check (link is null or link ~* '^https?://'),
  image_url   text check (image_url is null or image_url ~* '^https?://'),
  -- Only published events appear on /events/. Drafts are for admins.
  published   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ce_events_starts_at on public.ce_events (starts_at);

-- People ----------------------------------------------------------------------

create table if not exists public.ce_people (
  id            uuid primary key default gen_random_uuid(),
  first_name    text not null check (length(trim(first_name)) between 1 and 100),
  last_name     text check (last_name is null or length(last_name) <= 100),
  email         text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone         text check (phone is null or length(phone) <= 40),
  pronouns      text check (pronouns is null or length(pronouns) <= 40),
  headline      text check (headline is null or length(headline) <= 200),
  -- What they make: design, film, music, fashion, software, …
  disciplines   text[] not null default '{}',
  city          text check (city is null or length(city) <= 100),
  bio           text check (bio is null or length(bio) <= 4000),
  links         text[] not null default '{}',
  tags          text[] not null default '{}',
  -- Admins' private notes. Never shown publicly.
  notes         text check (notes is null or length(notes) <= 8000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists ce_people_email on public.ce_people (lower(email)) where email is not null;
create index if not exists ce_people_name on public.ce_people (lower(first_name), lower(last_name));

-- Who came to what, and in what role.
create table if not exists public.ce_event_people (
  event_id   uuid not null references public.ce_events (id) on delete cascade,
  person_id  uuid not null references public.ce_people (id) on delete cascade,
  -- host, speaker, performer, artist, attendee, volunteer, partner
  role       text not null default 'attendee' check (length(role) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (event_id, person_id)
);
create index if not exists ce_event_people_person on public.ce_event_people (person_id);

-- Connections between people. Stored once per pair and kind, with the smaller
-- id first, so A–B and B–A are the same connection.
create table if not exists public.ce_connections (
  id         uuid primary key default gen_random_uuid(),
  person_a   uuid not null references public.ce_people (id) on delete cascade,
  person_b   uuid not null references public.ce_people (id) on delete cascade,
  -- met, collaborated, introduced, mentor, friends
  kind       text not null default 'met' check (length(kind) between 1 and 40),
  note       text check (note is null or length(note) <= 2000),
  -- Where they met or what brought them together, if an event did.
  event_id   uuid references public.ce_events (id) on delete set null,
  created_at timestamptz not null default now(),
  check (person_a < person_b),
  unique (person_a, person_b, kind)
);
create index if not exists ce_connections_b on public.ce_connections (person_b);

-- Put the pair in order, so callers can pass the two people either way round.
create or replace function public.ce_connections_order()
returns trigger
language plpgsql
as $$
declare t uuid;
begin
  if new.person_a = new.person_b then
    raise exception 'A person can''t be connected to themselves';
  end if;
  if new.person_a > new.person_b then
    t := new.person_a; new.person_a := new.person_b; new.person_b := t;
  end if;
  return new;
end;
$$;

-- 3. Partners and website words -------------------------------------------------

create table if not exists public.ce_partners (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  url         text check (url is null or url ~* '^https?://'),
  logo_url    text check (logo_url is null or logo_url ~* '^https?://'),
  sort        integer not null default 0,
  published   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The words on the public pages, by key (home.lede, home.intro, …). A page
-- keeps its own built-in words for any key that isn't set here.
create table if not exists public.ce_site_content (
  key        text primary key check (key ~ '^[a-z0-9_.-]{1,80}$'),
  value      text not null check (length(value) <= 8000),
  updated_at timestamptz not null default now()
);

-- Photos and write-ups -----------------------------------------------------------

-- Each event gets a web address (/events/event/?e=<slug>), a cover photo, a
-- gallery, and its story: what happened (past) or what to expect (upcoming).
alter table public.ce_events add column if not exists slug      text;
alter table public.ce_events add column if not exists cover_url text check (cover_url is null or cover_url ~* '^https?://');
alter table public.ce_events add column if not exists photos    text[] not null default '{}';
alter table public.ce_events add column if not exists story     text check (story is null or length(story) <= 20000);
create unique index if not exists ce_events_slug on public.ce_events (slug);
alter table public.ce_people add column if not exists photo_url text check (photo_url is null or photo_url ~* '^https?://');

-- "Opening Salon" on 12 Sep 2026 → opening-salon-2026-09-12 (made unique).
create or replace function public.ce_events_slug()
returns trigger
language plpgsql
as $$
declare base text; candidate text; n int := 1;
begin
  if new.slug is not null and new.slug <> '' and (tg_op = 'INSERT' or new.slug = old.slug) then
    return new;
  end if;
  base := trim(both '-' from regexp_replace(lower(new.title), '[^a-z0-9]+', '-', 'g'));
  base := left(coalesce(nullif(base, ''), 'event'), 60) || '-' || to_char(new.starts_at at time zone 'UTC', 'YYYY-MM-DD');
  candidate := base;
  while exists (select 1 from public.ce_events where slug = candidate and id <> new.id) loop
    n := n + 1; candidate := base || '-' || n;
  end loop;
  new.slug := candidate;
  return new;
end;
$$;

-- Triggers --------------------------------------------------------------------

drop trigger if exists ce_events_touch on public.ce_events;
create trigger ce_events_touch before update on public.ce_events for each row execute function public.ce_touch();
drop trigger if exists ce_people_touch on public.ce_people;
create trigger ce_people_touch before update on public.ce_people for each row execute function public.ce_touch();
drop trigger if exists ce_partners_touch on public.ce_partners;
create trigger ce_partners_touch before update on public.ce_partners for each row execute function public.ce_touch();
drop trigger if exists ce_site_content_touch on public.ce_site_content;
create trigger ce_site_content_touch before update on public.ce_site_content for each row execute function public.ce_touch();
drop trigger if exists ce_events_slug on public.ce_events;
create trigger ce_events_slug before insert or update of title, starts_at, slug on public.ce_events for each row
  when (new.slug is null or new.slug = '') execute function public.ce_events_slug();
update public.ce_events set slug = null where slug is null;
drop trigger if exists ce_connections_order on public.ce_connections;
create trigger ce_connections_order before insert or update on public.ce_connections for each row execute function public.ce_connections_order();

-- 4. Who can see and change what ---------------------------------------------------

alter table public.ce_admins       enable row level security;
alter table public.ce_events       enable row level security;
alter table public.ce_people       enable row level security;
alter table public.ce_event_people enable row level security;
alter table public.ce_connections  enable row level security;
alter table public.ce_partners     enable row level security;
alter table public.ce_site_content enable row level security;

drop policy if exists ce_admins_admin on public.ce_admins;
create policy ce_admins_admin on public.ce_admins for all to authenticated
  using (public.ce_is_admin()) with check (public.ce_is_admin());

drop policy if exists ce_events_public on public.ce_events;
create policy ce_events_public on public.ce_events for select to anon, authenticated
  using (published or public.ce_is_admin());
drop policy if exists ce_events_admin on public.ce_events;
create policy ce_events_admin on public.ce_events for all to authenticated
  using (public.ce_is_admin()) with check (public.ce_is_admin());

drop policy if exists ce_people_admin on public.ce_people;
create policy ce_people_admin on public.ce_people for all to authenticated
  using (public.ce_is_admin()) with check (public.ce_is_admin());

drop policy if exists ce_event_people_admin on public.ce_event_people;
create policy ce_event_people_admin on public.ce_event_people for all to authenticated
  using (public.ce_is_admin()) with check (public.ce_is_admin());

drop policy if exists ce_connections_admin on public.ce_connections;
create policy ce_connections_admin on public.ce_connections for all to authenticated
  using (public.ce_is_admin()) with check (public.ce_is_admin());

drop policy if exists ce_partners_public on public.ce_partners;
create policy ce_partners_public on public.ce_partners for select to anon, authenticated
  using (published or public.ce_is_admin());
drop policy if exists ce_partners_admin on public.ce_partners;
create policy ce_partners_admin on public.ce_partners for all to authenticated
  using (public.ce_is_admin()) with check (public.ce_is_admin());

drop policy if exists ce_site_content_public on public.ce_site_content;
create policy ce_site_content_public on public.ce_site_content for select to anon, authenticated
  using (true);
drop policy if exists ce_site_content_admin on public.ce_site_content;
create policy ce_site_content_admin on public.ce_site_content for all to authenticated
  using (public.ce_is_admin()) with check (public.ce_is_admin());

grant select on public.ce_events, public.ce_partners, public.ce_site_content to anon;
grant select, insert, update, delete on
  public.ce_admins, public.ce_events, public.ce_people, public.ce_event_people,
  public.ce_connections, public.ce_partners, public.ce_site_content
  to authenticated;

-- Building connections ---------------------------------------------------------

-- People this person isn't connected to yet, best first: those who were at the
-- same events (3 points per shared event), then those who share disciplines or
-- tags (1 point each). Admins only.
create or replace function public.ce_connection_suggestions(p_person uuid, p_limit integer default 10)
returns table (person_id uuid, first_name text, last_name text, headline text, score integer, shared_events integer, shared_interests text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.ce_is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
  with me as (
    select disciplines || tags as interests from ce_people where id = p_person
  ),
  shared as (
    select ep2.person_id, count(*)::int as n
    from ce_event_people ep1
    join ce_event_people ep2 on ep2.event_id = ep1.event_id and ep2.person_id <> ep1.person_id
    where ep1.person_id = p_person
    group by ep2.person_id
  ),
  connected as (
    select case when person_a = p_person then person_b else person_a end as id
    from ce_connections where p_person in (person_a, person_b)
  ),
  scored as (
    select p.id, p.first_name, p.last_name, p.headline,
      coalesce(s.n, 0) as n,
      array(select distinct lower(x) from unnest(p.disciplines || p.tags) x
            where lower(x) in (select lower(y) from me, unnest(me.interests) y)) as common
    from ce_people p
    left join shared s on s.person_id = p.id
    where p.id <> p_person and p.id not in (select id from connected)
  )
  select id, scored.first_name, scored.last_name, scored.headline,
    (n * 3 + cardinality(common))::int, n, common
  from scored
  where n > 0 or cardinality(common) > 0
  order by 5 desc, scored.first_name
  limit greatest(1, least(coalesce(p_limit, 10), 50));
end;
$$;

-- Connect everyone at an event to each other as "met" (skipping pairs that
-- already have a "met" connection). Returns how many new connections it made.
create or replace function public.ce_connect_event(p_event uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare made integer;
begin
  if not public.ce_is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  insert into ce_connections (person_a, person_b, kind, event_id)
  select a.person_id, b.person_id, 'met', p_event
  from ce_event_people a
  join ce_event_people b on b.event_id = a.event_id and a.person_id < b.person_id
  where a.event_id = p_event
  on conflict (person_a, person_b, kind) do nothing;
  get diagnostics made = row_count;
  return made;
end;
$$;

revoke all on function public.ce_connection_suggestions(uuid, integer) from public, anon;
revoke all on function public.ce_connect_event(uuid) from public, anon;
grant execute on function public.ce_connection_suggestions(uuid, integer) to authenticated;
grant execute on function public.ce_connect_event(uuid) to authenticated;
grant execute on function public.ce_is_admin() to anon, authenticated;

-- Adding and removing admins (used by /manage/ → Admins).
create or replace function public.ce_add_admin(p_email text)
returns public.ce_admins
language plpgsql
security definer
set search_path = public
as $$
declare row public.ce_admins;
begin
  if not public.ce_is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  insert into ce_admins (email) values (lower(trim(p_email)))
  on conflict (email) do update set email = excluded.email
  returning * into row;
  return row;
end;
$$;

-- You can't remove yourself, so there's always at least one admin left.
create or replace function public.ce_remove_admin(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.ce_is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if lower(trim(p_email)) = public.ce_my_email() then
    raise exception 'You can''t remove yourself as an admin.' using errcode = '22023';
  end if;
  delete from ce_admins where email = lower(trim(p_email));
  return found;
end;
$$;

revoke all on function public.ce_add_admin(text) from public, anon;
revoke all on function public.ce_remove_admin(text) from public, anon;
grant execute on function public.ce_add_admin(text) to authenticated;
grant execute on function public.ce_remove_admin(text) to authenticated;
revoke all on function public.ce_my_email() from public, anon;
grant execute on function public.ce_my_email() to authenticated;

-- 5. Members and introductions -----------------------------------------------------
--
-- A member is someone on the People list in /manage/ who has made an account
-- on /sign-in/ with the same email address and confirmed it. So to let someone
-- in, add them to People with their email; there's nothing else to switch on.
--
-- Introductions: a member asks someone they're connected to (the connector)
-- to introduce them to one of the connector's connections (the target). The
-- connector introduces them or passes; then the target says "Happy to meet"
-- or "Not now". Saying yes connects the two. Connections are the ones
-- recorded in /manage/ (including "connect everyone at an event").
--
-- Members never read the tables directly: the functions below decide what
-- each person may see and do. The requester isn't told whether it was the
-- connector or the target who said no.

create table if not exists public.ce_intros (
  id             uuid primary key default gen_random_uuid(),
  requester      uuid not null references public.ce_people (id) on delete cascade,
  connector      uuid not null references public.ce_people (id) on delete cascade,
  target         uuid not null references public.ce_people (id) on delete cascade,
  -- Why the requester would like to meet the target.
  reason         text not null check (length(trim(reason)) between 20 and 600),
  -- The connector's note to the target, when they pass it on.
  connector_note text check (connector_note is null or length(connector_note) <= 600),
  -- pending: waiting on the connector; introduced: waiting on the target;
  -- accepted: connected; declined_by_connector / declined_by_target; cancelled.
  status         text not null default 'pending'
                 check (status in ('pending', 'introduced', 'accepted', 'declined_by_connector', 'declined_by_target', 'cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (requester <> connector and requester <> target and connector <> target)
);
-- One open request per person you'd like to meet.
create unique index if not exists ce_intros_open on public.ce_intros (requester, target) where status in ('pending', 'introduced');
create index if not exists ce_intros_connector on public.ce_intros (connector);
create index if not exists ce_intros_target on public.ce_intros (target);

drop trigger if exists ce_intros_touch on public.ce_intros;
create trigger ce_intros_touch before update on public.ce_intros for each row execute function public.ce_touch();

-- Admins can see every introduction (for the record); members go through the functions.
alter table public.ce_intros enable row level security;
drop policy if exists ce_intros_admin on public.ce_intros;
create policy ce_intros_admin on public.ce_intros for select to authenticated using (public.ce_is_admin());
grant select on public.ce_intros to authenticated;

-- The People entry of whoever is signed in, if they're a member.
create or replace function public.ce_my_person()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.ce_people where lower(email) = public.ce_my_email() limit 1;
$$;

-- People who are members (have a confirmed account with their email).
create or replace function public.ce_member_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id from public.ce_people p
  join auth.users u on lower(u.email) = lower(p.email) and u.email_confirmed_at is not null;
$$;

-- Who's signed in, for /sign-in/: their name if they're a member, and whether they're an admin.
create or replace function public.ce_me()
returns table (person_id uuid, first_name text, last_name text, is_admin boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.first_name, p.last_name, public.ce_is_admin()
  from (select 1) one
  left join public.ce_people p on p.id = public.ce_my_person();
$$;

-- People the signed-in member could meet: members connected to one of their
-- connections (who are members too) but not to them yet. With who knows them.
create or replace function public.ce_intro_suggestions()
returns table (target_id uuid, first_name text, last_name text, headline text, city text, photo_url text, connectors jsonb, open_request_status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare me uuid := public.ce_my_person();
begin
  if me is null then return; end if;
  return query
  with members as (select * from public.ce_member_ids() id),
  mine as (
    select distinct case when c.person_a = me then c.person_b else c.person_a end as id
    from ce_connections c where me in (c.person_a, c.person_b)
  ),
  second as (
    select distinct m.id as connector, case when c.person_a = m.id then c.person_b else c.person_a end as target
    from mine m
    join members mm on mm.id = m.id
    join ce_connections c on m.id in (c.person_a, c.person_b)
  )
  select t.id, t.first_name, t.last_name, t.headline, t.city, t.photo_url,
    jsonb_agg(distinct jsonb_build_object('id', cp.id, 'first_name', cp.first_name, 'last_name', cp.last_name)),
    (select i.status from ce_intros i where i.requester = me and i.target = t.id and i.status in ('pending', 'introduced') limit 1)
  from second s
  join ce_people t on t.id = s.target
  join members tm on tm.id = t.id
  join ce_people cp on cp.id = s.connector
  where s.target <> me and s.target not in (select id from mine)
  group by t.id
  order by t.first_name, t.last_name;
end;
$$;

-- The signed-in member's introductions: ones they asked for, ones they've
-- been asked to make, and ones made to them (once the connector has agreed).
create or replace function public.ce_my_intros()
returns table (id uuid, role text, status text, reason text, connector_note text, created_at timestamptz, requester jsonb, connector jsonb, target jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare me uuid := public.ce_my_person();
begin
  if me is null then return; end if;
  return query
  select i.id,
    case when i.requester = me then 'requester' when i.connector = me then 'connector' else 'target' end,
    case when i.requester = me and i.status like 'declined%' then 'declined' else i.status end,
    i.reason, i.connector_note, i.created_at,
    jsonb_build_object('id', r.id, 'first_name', r.first_name, 'last_name', r.last_name, 'headline', r.headline, 'city', r.city),
    jsonb_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name),
    jsonb_build_object('id', t.id, 'first_name', t.first_name, 'last_name', t.last_name)
  from ce_intros i
  join ce_people r on r.id = i.requester
  join ce_people c on c.id = i.connector
  join ce_people t on t.id = i.target
  where i.requester = me or i.connector = me
     or (i.target = me and i.status in ('introduced', 'accepted', 'declined_by_target'))
  order by i.created_at desc;
end;
$$;

-- Ask a connection to introduce you to someone they know.
create or replace function public.ce_request_intro(p_target uuid, p_connector uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := public.ce_my_person(); new_id uuid;
begin
  if me is null then
    raise exception 'Only members can ask for introductions.' using errcode = '42501';
  end if;
  if p_target = me or p_connector = me or p_target = p_connector then
    raise exception 'That introduction isn''t possible.' using errcode = '22023';
  end if;
  if not exists (select 1 from ce_member_ids() id where id = p_target)
     or not exists (select 1 from ce_member_ids() id where id = p_connector) then
    raise exception 'That person isn''t a member yet.' using errcode = '22023';
  end if;
  if not exists (select 1 from ce_connections where person_a = least(me, p_connector) and person_b = greatest(me, p_connector))
     or not exists (select 1 from ce_connections where person_a = least(p_target, p_connector) and person_b = greatest(p_target, p_connector)) then
    raise exception 'You can only ask someone you''re connected to, about someone they''re connected to.' using errcode = '22023';
  end if;
  if exists (select 1 from ce_connections where person_a = least(me, p_target) and person_b = greatest(me, p_target)) then
    raise exception 'You''re already connected.' using errcode = '22023';
  end if;
  if exists (select 1 from ce_intros where requester = me and target = p_target and status in ('pending', 'introduced')) then
    raise exception 'You''ve already asked to meet them.' using errcode = '23505';
  end if;
  if (select count(*) from ce_intros where requester = me and status in ('pending', 'introduced')) >= 10 then
    raise exception 'You have 10 requests waiting. Wait for some answers before asking again.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 20 then
    raise exception 'Please say a little more about why you''d like to meet.' using errcode = '22023';
  end if;
  insert into ce_intros (requester, connector, target, reason)
  values (me, p_connector, p_target, left(trim(p_reason), 600))
  returning ce_intros.id into new_id;
  return new_id;
end;
$$;

-- Answer an introduction. Connector: introduce / decline. Target: accept /
-- decline. Requester: cancel (while it's still with the connector).
-- Returns the new status.
create or replace function public.ce_respond_intro(p_id uuid, p_action text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := public.ce_my_person(); r ce_intros; new_status text;
begin
  select * into r from ce_intros where id = p_id for update;
  if me is null or r.id is null or me not in (r.requester, r.connector, r.target) then
    raise exception 'Introduction not found.' using errcode = 'P0002';
  end if;
  new_status := case
    when me = r.connector and r.status = 'pending' and p_action = 'introduce' then 'introduced'
    when me = r.connector and r.status = 'pending' and p_action = 'decline' then 'declined_by_connector'
    when me = r.target and r.status = 'introduced' and p_action = 'accept' then 'accepted'
    when me = r.target and r.status = 'introduced' and p_action = 'decline' then 'declined_by_target'
    when me = r.requester and r.status = 'pending' and p_action = 'cancel' then 'cancelled'
  end;
  if new_status is null then
    raise exception 'This request has already been answered.' using errcode = '22023';
  end if;
  update ce_intros set status = new_status,
    connector_note = case when new_status = 'introduced' then nullif(left(trim(coalesce(p_note, '')), 600), '') else connector_note end
  where id = p_id;
  if new_status = 'accepted' then
    insert into ce_connections (person_a, person_b, kind, note)
    values (r.requester, r.target, 'introduced',
      'Introduced by ' || (select concat_ws(' ', first_name, last_name) from ce_people where id = r.connector))
    on conflict (person_a, person_b, kind) do nothing;
  end if;
  return new_status;
end;
$$;

revoke all on function public.ce_my_person() from public, anon;
revoke all on function public.ce_member_ids() from public, anon, authenticated;
revoke all on function public.ce_me() from public, anon;
revoke all on function public.ce_intro_suggestions() from public, anon;
revoke all on function public.ce_my_intros() from public, anon;
revoke all on function public.ce_request_intro(uuid, uuid, text) from public, anon;
revoke all on function public.ce_respond_intro(uuid, text, text) from public, anon;
grant execute on function public.ce_my_person() to authenticated;
grant execute on function public.ce_me() to authenticated;
grant execute on function public.ce_intro_suggestions() to authenticated;
grant execute on function public.ce_my_intros() to authenticated;
grant execute on function public.ce_request_intro(uuid, uuid, text) to authenticated;
grant execute on function public.ce_respond_intro(uuid, text, text) to authenticated;

-- 6. Photo storage -------------------------------------------------------------------


-- One public bucket for event photos, people's photos and partner logos.
-- Anyone can view a photo by its link; only admins can upload or remove.
-- Uploads are resized in the browser first; 15 MB is a backstop.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('ce-photos', 'ce-photos', true, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
    on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

    execute 'drop policy if exists ce_photos_admin_insert on storage.objects';
    execute 'drop policy if exists ce_photos_admin_update on storage.objects';
    execute 'drop policy if exists ce_photos_admin_delete on storage.objects';
    execute $p$create policy ce_photos_admin_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'ce-photos' and public.ce_is_admin())$p$;
    execute $p$create policy ce_photos_admin_update on storage.objects for update to authenticated
      using (bucket_id = 'ce-photos' and public.ce_is_admin()) with check (bucket_id = 'ce-photos' and public.ce_is_admin())$p$;
    execute $p$create policy ce_photos_admin_delete on storage.objects for delete to authenticated
      using (bucket_id = 'ce-photos' and public.ce_is_admin())$p$;
  end if;
end $$;
