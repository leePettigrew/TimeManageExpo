-- 0010_push.sql — push notifications for instant locate + live wake-ups.
--
-- Flow: app registers an Expo push token -> manager taps "locate" ->
-- request_location() (0007) inserts a location_requests row -> a trigger
-- enqueues a push_outbox job and NOTIFYs -> the push-worker service (in the
-- Docker stack) sends a data-only push via Expo -> the phone's background
-- notification task wakes, captures a fix and syncs. Push is an ACCELERATOR:
-- the 30s sync poll remains the fallback, so locate still works without it.

-- one push token per device; a worker may have several devices
create table device_tokens (
  token       text primary key,           -- ExpoPushToken[...]
  worker_id   uuid not null,
  company_id  uuid not null,
  platform    text not null check (platform in ('android', 'ios')),
  updated_at  timestamptz not null default now(),
  foreign key (company_id, worker_id) references profiles (company_id, id)
);
create index device_tokens_worker_idx on device_tokens (worker_id);

alter table device_tokens enable row level security;
-- no client grants: registered via RPC only; the push-worker reads over a
-- direct DB connection (bypasses RLS)

create function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles := internal.require_profile();
begin
  if p_token is null or p_token = '' then
    raise exception 'token_required' using errcode = 'P0001';
  end if;
  if p_platform not in ('android', 'ios') then
    raise exception 'invalid_platform' using errcode = 'P0001';
  end if;
  insert into public.device_tokens (token, worker_id, company_id, platform, updated_at)
  values (p_token, v_profile.id, v_profile.company_id, p_platform, now())
  on conflict (token) do update set
    worker_id = excluded.worker_id,
    company_id = excluded.company_id,
    platform = excluded.platform,
    updated_at = now();
end;
$$;

revoke all on function public.register_push_token(text, text) from public;
grant execute on function public.register_push_token(text, text) to authenticated;

-- durable push queue (survives push-worker restarts)
create table push_outbox (
  id         bigint generated always as identity primary key,
  worker_id  uuid not null,
  company_id uuid not null,
  kind       text not null,               -- 'locate'
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  attempts   int not null default 0,
  last_error text
);
create index push_outbox_pending_idx on push_outbox (created_at) where sent_at is null;

alter table push_outbox enable row level security; -- no client access at all

-- a new locate request enqueues a push and wakes the worker service
create function internal.enqueue_locate_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.push_outbox (worker_id, company_id, kind, payload)
  values (new.worker_id, new.company_id, 'locate',
          jsonb_build_object('request_id', new.id));
  perform pg_notify('push_wake', new.worker_id::text);
  return new;
end;
$$;

create trigger location_request_push
  after insert on location_requests
  for each row execute function internal.enqueue_locate_push();
