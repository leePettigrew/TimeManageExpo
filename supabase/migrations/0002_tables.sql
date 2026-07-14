-- 0002_tables.sql — core schema.
-- Design invariants:
--  * every tenant table carries NOT NULL company_id
--  * event tables (shifts, location_pings) are append-only for clients:
--    no INSERT/UPDATE/DELETE grants — writes happen only via SECURITY DEFINER RPCs
--  * composite FKs (company_id, worker_id) -> profiles(company_id, id) make
--    cross-tenant references unrepresentable
--  * client-generated UUIDs + UNIQUE constraints give idempotent ingestion

create table companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  settings   jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- profiles.id = auth.users.id (GoTrue user)
create table profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references companies (id),
  role       text not null check (role in ('manager', 'worker')),
  full_name  text not null default '',
  phone_e164 text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, id) -- target for composite FKs below
);

create index profiles_company_idx on profiles (company_id);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  phone_e164 text not null,
  role       text not null check (role in ('manager', 'worker')),
  full_name  text not null default '',
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  claimed_at timestamptz,
  claimed_by uuid references profiles (id)
);

-- one pending invite per phone number across the whole system
create unique index invites_pending_phone_uq on invites (phone_e164) where claimed_at is null;
create index invites_company_idx on invites (company_id);

-- GDPR transparency-screen acknowledgment (Art 13 evidence; lawful basis is
-- the employer's legitimate interest — this records disclosure, not consent)
create table acknowledgments (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  worker_id      uuid not null,
  notice_version text not null,
  acknowledged_at timestamptz not null default now(),
  foreign key (company_id, worker_id) references profiles (company_id, id),
  unique (worker_id, notice_version)
);

create table shifts (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references companies (id),
  worker_id              uuid not null,
  client_event_id        uuid not null,          -- clock-in event id (device-generated)
  status                 text not null default 'open'
                           check (status in ('open', 'closed', 'auto_closed', 'disputed')),
  -- clock-in evidence
  clock_in_device_at     timestamptz not null,   -- device clock (never trusted for ordering)
  clock_in_received_at   timestamptz not null default now(), -- server authoritative
  clock_in_lat           double precision,
  clock_in_lng           double precision,
  clock_in_accuracy_m    real,
  clock_in_mocked        boolean not null default false,
  -- clock-out evidence (null while open)
  clock_out_client_event_id uuid,
  clock_out_device_at    timestamptz,
  clock_out_received_at  timestamptz,
  clock_out_lat          double precision,
  clock_out_lng          double precision,
  clock_out_accuracy_m   real,
  clock_out_mocked       boolean,
  device_info            jsonb not null default '{}',
  anomaly_flags          text[] not null default '{}',
  created_at             timestamptz not null default now(),
  unique (company_id, client_event_id),          -- idempotent clock-in
  foreign key (company_id, worker_id) references profiles (company_id, id)
);

-- one open shift per worker: overlapping/duplicate open shifts are unrepresentable
create unique index shifts_one_open_per_worker on shifts (worker_id) where status = 'open';
-- idempotent clock-out
create unique index shifts_clock_out_event_uq on shifts (company_id, clock_out_client_event_id)
  where clock_out_client_event_id is not null;
create index shifts_company_time_idx on shifts (company_id, clock_in_received_at desc);
create index shifts_worker_time_idx on shifts (worker_id, clock_in_received_at desc);

-- Breadcrumb trail. Partitioned monthly by server receive time so GDPR
-- retention is a partition drop, not a giant DELETE. Partition key must be in
-- the PK; global uniqueness of client_ping_id is enforced by the sync RPC
-- (advisory-locked per worker), not by the engine.
create table location_pings (
  id           bigint generated always as identity,
  company_id   uuid not null,
  shift_id     uuid not null references shifts (id),
  worker_id    uuid not null,
  client_ping_id uuid not null,
  seq          integer not null,
  device_at    timestamptz not null,
  received_at  timestamptz not null default now(),
  lat          double precision not null,
  lng          double precision not null,
  accuracy_m   real,
  speed_mps    real,
  mocked       boolean not null default false,
  battery_pct  smallint check (battery_pct between 0 and 100),
  primary key (received_at, id),
  foreign key (company_id, worker_id) references profiles (company_id, id)
) partition by range (received_at);

-- safety net for rows outside pre-created monthly partitions
create table location_pings_default partition of location_pings default;

create index location_pings_shift_idx on location_pings (shift_id, seq);
create index location_pings_dedupe_idx on location_pings (company_id, client_ping_id);
create index location_pings_company_time_idx on location_pings (company_id, received_at desc);

-- One row per worker; drives the live map + realtime without streaming the
-- pings firehose to every dashboard subscriber.
create table worker_latest_ping (
  worker_id   uuid primary key,
  company_id  uuid not null,
  shift_id    uuid not null,
  lat         double precision not null,
  lng         double precision not null,
  accuracy_m  real,
  mocked      boolean not null default false,
  battery_pct smallint,
  device_at   timestamptz not null,
  received_at timestamptz not null default now(),
  foreign key (company_id, worker_id) references profiles (company_id, id)
);

create index worker_latest_ping_company_idx on worker_latest_ping (company_id);

-- Append-only manager corrections. Original shift evidence is never mutated;
-- timesheet views apply the latest adjustment per field.
create table adjustments (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  shift_id   uuid not null references shifts (id),
  manager_id uuid not null,
  field      text not null check (field in ('clock_in_at', 'clock_out_at', 'status', 'note')),
  old_value  text,
  new_value  text,
  reason     text not null,
  created_at timestamptz not null default now(),
  foreign key (company_id, manager_id) references profiles (company_id, id)
);

create index adjustments_shift_idx on adjustments (shift_id, created_at desc);

create table audit_log (
  id         bigint generated always as identity primary key,
  company_id uuid,
  actor_id   uuid,
  action     text not null,
  entity     text,
  entity_id  text,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_log_company_idx on audit_log (company_id, created_at desc);

-- Realtime: self-hosted Supabase creates the supabase_realtime publication;
-- add the two tables the dashboard subscribes to (skip on vanilla PG tests).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table shifts, worker_latest_ping;
  end if;
end
$$;

-- UPDATE payloads over realtime need full row images
alter table worker_latest_ping replica identity full;
alter table shifts replica identity full;
