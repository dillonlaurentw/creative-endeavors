-- Local testing only: the small part of Supabase that setup.sql relies on
-- (the anon and authenticated roles, auth.users, auth.uid()), for running
-- setup.sql and the tests on a plain Postgres. Never run this in Supabase.
create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
