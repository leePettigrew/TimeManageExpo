-- 0007_location_controls.sql — manager-tunable ping rate + on-demand
-- location requests. GDPR guardrails: both only function during an OPEN
-- shift, every request is audited, and workers can see their own requests.

-- Per-worker breadcrumb interval (seconds). Floor of 60s keeps battery and
-- proportionality sane; ceiling of 15 min keeps trails meaningful.
alter table profiles
  add column ping_interval_s int not null default 90
  check (ping_interval_s between 60 and 900);

-- managers may tune it for their own company (column-level grant; the
-- existing profiles_update policy already restricts to same-company managers)
grant update (ping_interval_s) on profiles to authenticated;

create table location_requests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  worker_id    uuid not null,
  requested_by uuid not null,
  created_at   timestamptz not null default now(),
  fulfilled_at timestamptz,
  foreign key (company_id, worker_id) references profiles (company_id, id),
  foreign key (company_id, requested_by) references profiles (company_id, id)
);

create index location_requests_pending_idx on location_requests (worker_id) where fulfilled_at is null;
create index location_requests_company_idx on location_requests (company_id, created_at desc);

alter table location_requests enable row level security;

-- workers see their own requests (transparency); managers see their company's
grant select on location_requests to authenticated;
create policy location_requests_select on location_requests for select to authenticated
  using (
    worker_id = auth.uid()
    or (company_id = (select internal.current_company_id())
        and (select internal.is_manager()))
  );
-- writes only via RPCs below — no INSERT/UPDATE/DELETE grants

-- realtime: dashboards watch requests resolve
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table location_requests;
  end if;
end
$$;
alter table location_requests replica identity full;

-- Manager asks "where is X right now?". Only valid mid-shift; dedupes onto an
-- already-pending request instead of stacking spam.
create function public.request_location(p_worker_id uuid)
returns public.location_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles := internal.require_profile();
  v_request public.location_requests;
begin
  if v_profile.role <> 'manager' then
    raise exception 'manager_only' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_worker_id and company_id = v_profile.company_id and is_active
  ) then
    raise exception 'worker_not_found' using errcode = 'P0001';
  end if;

  -- the hard GDPR line: no open shift, no location check
  if not exists (
    select 1 from public.shifts
    where worker_id = p_worker_id and status = 'open'
  ) then
    raise exception 'worker_not_clocked_in' using errcode = 'P0001';
  end if;

  -- an unfulfilled request already covers "now"
  select * into v_request from public.location_requests
  where worker_id = p_worker_id and fulfilled_at is null
  order by created_at desc limit 1;
  if found then
    return v_request;
  end if;

  insert into public.location_requests (company_id, worker_id, requested_by)
  values (v_profile.company_id, p_worker_id, v_profile.id)
  returning * into v_request;

  perform internal.audit(v_profile.company_id, v_profile.id, 'location_requested',
                         'location_requests', v_request.id::text,
                         jsonb_build_object('worker_id', p_worker_id));
  return v_request;
end;
$$;

revoke all on function public.request_location(uuid) from public;
grant execute on function public.request_location(uuid) to authenticated;

-- Fulfilment: a fresh accepted point answers any pending request. Wired into
-- sync_location_batch via this helper (called with the newest accepted
-- device time).
create function internal.fulfil_location_requests(p_worker_id uuid, p_latest_device_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.location_requests
  set fulfilled_at = now()
  where worker_id = p_worker_id
    and fulfilled_at is null
    and created_at <= p_latest_device_at + interval '5 minutes';
$$;

-- Updated sync_location_batch: identical to 0004's version plus tracking of
-- the newest accepted device time, which fulfils pending location requests.
-- (CREATE OR REPLACE keeps the existing grants.)
create or replace function public.sync_location_batch(p_shift_id uuid, p_points jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile   public.profiles := internal.require_profile();
  v_shift     public.shifts;
  v_pt        jsonb;
  v_id        uuid;
  v_device_at timestamptz;
  v_lat       double precision;
  v_lng       double precision;
  v_mocked    boolean;
  v_accepted  int := 0;
  v_dupes     int := 0;
  v_rejected  int := 0;
  v_any_mock  boolean := false;
  v_window_lo timestamptz;
  v_window_hi timestamptz;
  -- physics checks (batch-local): teleportation + mock-app accuracy signature
  v_prev_lat  double precision;
  v_prev_lng  double precision;
  v_prev_at   timestamptz;
  v_gap_s     double precision;
  v_impossible boolean := false;
  v_acc1_count int := 0;
  v_max_device_at timestamptz;
begin
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    raise exception 'points_array_required' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_points) > 500 then
    raise exception 'batch_too_large' using errcode = 'P0001';
  end if;

  select * into v_shift from public.shifts
  where id = p_shift_id and worker_id = v_profile.id;
  if not found then
    raise exception 'shift_not_found' using errcode = 'P0001';
  end if;

  -- serialise syncs per worker: makes the dedupe check race-free without a
  -- global unique index (impossible across partitions)
  perform pg_advisory_xact_lock(hashtextextended(v_profile.id::text, 42));

  perform internal.ensure_ping_partition(now());

  -- points must have been captured while the shift was plausibly running;
  -- a shift closed without clock-out evidence (auto_closed) is bounded by the
  -- auto-close horizon, so it can never keep accepting fresh pings
  v_window_lo := v_shift.clock_in_device_at - interval '5 minutes';
  v_window_hi := coalesce(
    v_shift.clock_out_device_at,
    case when v_shift.status = 'open' then now()
         else v_shift.clock_in_device_at + interval '20 hours' end
  ) + interval '5 minutes';

  for v_pt in select * from jsonb_array_elements(p_points) loop
    begin
      v_id        := (v_pt->>'id')::uuid;
      v_device_at := (v_pt->>'device_at')::timestamptz;
      v_lat       := (v_pt->>'lat')::double precision;
      v_lng       := (v_pt->>'lng')::double precision;
      v_mocked    := coalesce((v_pt->>'mocked')::boolean, false);
    exception when others then
      v_rejected := v_rejected + 1;
      continue;
    end;

    if v_id is null or v_device_at is null or v_lat is null or v_lng is null
       or v_lat not between -90 and 90 or v_lng not between -180 and 180
       or v_device_at < v_window_lo or v_device_at > v_window_hi
       or v_device_at > now() + interval '5 minutes' then
      v_rejected := v_rejected + 1;
      continue;
    end if;

    if exists (select 1 from public.location_pings
               where company_id = v_shift.company_id and client_ping_id = v_id) then
      v_dupes := v_dupes + 1;
      continue;
    end if;

    insert into public.location_pings (
      company_id, shift_id, worker_id, client_ping_id, seq,
      device_at, lat, lng, accuracy_m, speed_mps, mocked, battery_pct
    ) values (
      v_shift.company_id, v_shift.id, v_profile.id, v_id,
      coalesce((v_pt->>'seq')::int, 0),
      v_device_at, v_lat, v_lng,
      (v_pt->>'accuracy_m')::real, (v_pt->>'speed_mps')::real,
      v_mocked, (v_pt->>'battery_pct')::smallint
    );
    v_accepted := v_accepted + 1;
    v_any_mock := v_any_mock or v_mocked;
    v_max_device_at := greatest(coalesce(v_max_device_at, v_device_at), v_device_at);

    -- impossible travel between consecutive accepted points (> 200 km/h)
    if v_prev_at is not null and v_device_at > v_prev_at then
      v_gap_s := extract(epoch from v_device_at - v_prev_at);
      if v_gap_s > 0
         and internal.haversine_m(v_prev_lat, v_prev_lng, v_lat, v_lng) / v_gap_s > 55 then
        v_impossible := true;
      end if;
    end if;
    v_prev_lat := v_lat;
    v_prev_lng := v_lng;
    v_prev_at  := v_device_at;

    -- mock apps often report a constant perfect accuracy of exactly 1.0 m
    if (v_pt->>'accuracy_m')::real = 1.0 then
      v_acc1_count := v_acc1_count + 1;
    end if;
  end loop;

  if v_any_mock then
    perform internal.add_shift_flag(v_shift.id, 'mock_location');
  end if;
  if v_impossible then
    perform internal.add_shift_flag(v_shift.id, 'impossible_speed');
  end if;
  if v_acc1_count >= 5 then
    perform internal.add_shift_flag(v_shift.id, 'suspicious_accuracy');
  end if;

  -- live map row: newest point wins, only while the shift is open
  if v_accepted > 0 and v_shift.status = 'open' then
    insert into public.worker_latest_ping as wlp
      (worker_id, company_id, shift_id, lat, lng, accuracy_m, mocked, battery_pct, device_at, received_at)
    select v_profile.id, v_shift.company_id, v_shift.id,
           (pt->>'lat')::double precision, (pt->>'lng')::double precision,
           (pt->>'accuracy_m')::real, coalesce((pt->>'mocked')::boolean, false),
           (pt->>'battery_pct')::smallint, (pt->>'device_at')::timestamptz, now()
    from (
      select pt from jsonb_array_elements(p_points) pt
      where (pt->>'device_at') is not null and (pt->>'lat') is not null and (pt->>'lng') is not null
        and (pt->>'device_at')::timestamptz between v_window_lo and v_window_hi
      order by (pt->>'device_at')::timestamptz desc
      limit 1
    ) latest
    on conflict (worker_id) do update set
      company_id = excluded.company_id, shift_id = excluded.shift_id,
      lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
      mocked = excluded.mocked, battery_pct = excluded.battery_pct,
      device_at = excluded.device_at, received_at = excluded.received_at
    where excluded.device_at > wlp.device_at;
  end if;

  -- a fresh point answers any pending "where are they now?" request
  if v_accepted > 0 then
    perform internal.fulfil_location_requests(v_profile.id, v_max_device_at);
  end if;

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_dupes, 'rejected', v_rejected);
end;
$$;
