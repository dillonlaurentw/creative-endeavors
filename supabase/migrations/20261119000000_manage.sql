-- Creative Endeavors: the back end behind /manage/.
--
-- Events (past and upcoming), the people in the community and what we know
-- about them, who came to what, the connections between people, partners,
-- and the words on the public pages. Admins edit everything from /manage/;
-- the public can read only published events, published partners and the
-- site text. People, attendance and connections are admin-only, because
-- they hold contact details and private notes.
--
-- Safe to run more than once. Tables are prefixed ce_ like the rest of the
-- site's tables in this Supabase project.

create extension if not exists pgcrypto;

-- Admins ----------------------------------------------------------------------

create table if not exists public.ce_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- True when the signed-in user is an admin. security definer so policies can
-- call it without the caller being able to read ce_admins themselves.
create or replace function public.ce_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.ce_admins where user_id = auth.uid());
$$;

-- Members already marked is_admin (the community pages) become admins here too.
do $$
begin
  if to_regclass('public.ce_members') is not null then
    execute $q$
      insert into public.ce_admins (user_id)
      select user_id from public.ce_members where is_admin
      on conflict do nothing
    $q$;
  end if;
end $$;

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

-- Events ----------------------------------------------------------------------

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
  -- Their site account, when they're also a member.
  member_user_id uuid references auth.users (id) on delete set null,
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

-- Partners and site text -----------------------------------------------------

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

-- Triggers --------------------------------------------------------------------

drop trigger if exists ce_events_touch on public.ce_events;
create trigger ce_events_touch before update on public.ce_events for each row execute function public.ce_touch();
drop trigger if exists ce_people_touch on public.ce_people;
create trigger ce_people_touch before update on public.ce_people for each row execute function public.ce_touch();
drop trigger if exists ce_partners_touch on public.ce_partners;
create trigger ce_partners_touch before update on public.ce_partners for each row execute function public.ce_touch();
drop trigger if exists ce_site_content_touch on public.ce_site_content;
create trigger ce_site_content_touch before update on public.ce_site_content for each row execute function public.ce_touch();
drop trigger if exists ce_connections_order on public.ce_connections;
create trigger ce_connections_order before insert or update on public.ce_connections for each row execute function public.ce_connections_order();

-- Who can see and change what ----------------------------------------------

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

-- Adding and removing admins ---------------------------------------------------

-- Make someone with a site account an admin, by the email they sign in with.
create or replace function public.ce_add_admin(p_email text)
returns public.ce_admins
language plpgsql
security definer
set search_path = public
as $$
declare u record; row public.ce_admins;
begin
  if not public.ce_is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  select id, email into u from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if u.id is null then
    raise exception 'No account uses that email yet. They need to sign up first.' using errcode = 'P0002';
  end if;
  insert into ce_admins (user_id, email) values (u.id, u.email)
  on conflict (user_id) do update set email = excluded.email
  returning * into row;
  return row;
end;
$$;

-- Remove an admin. You can't remove yourself, so there's always someone left.
create or replace function public.ce_remove_admin(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.ce_is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You can''t remove yourself as an admin.' using errcode = '22023';
  end if;
  delete from ce_admins where user_id = p_user;
  return found;
end;
$$;

-- Fill in admins' emails for the list in /manage/.
update public.ce_admins a set email = u.email from auth.users u where u.id = a.user_id and a.email is null;

revoke all on function public.ce_add_admin(text) from public, anon;
revoke all on function public.ce_remove_admin(uuid) from public, anon;
grant execute on function public.ce_add_admin(text) to authenticated;
grant execute on function public.ce_remove_admin(uuid) to authenticated;
