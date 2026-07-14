-- 0001_init.sql — extensions, schemas, roles
-- Runs on the Supabase self-hosted stack (roles/auth schema already exist)
-- and on vanilla Postgres test instances (shim created by test harness first).

-- gen_random_uuid() is built into PG13+; no extension needed.

-- Internal schema: helpers not exposed through PostgREST.
create schema if not exists internal;

-- Roles exist on any Supabase image; create when running on vanilla PG (tests).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Lock down default privileges: nothing is table-accessible unless granted explicitly.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
