-- 0004_rpcs.sql — the only write path for event data.
-- Every function is SECURITY DEFINER with a pinned search_path. Invariants:
--  * received_at is stamped server-side; the client's device timestamp is
--    stored as evidence but never trusted for ordering
--  * device timestamps are validated against a skew/offline window
--  * ingestion is idempotent on client-generated UUIDs
--  * the shift state machine is enforced here plus by unique indexes
--  * anomalies are flagged for manager review, never silently dropped

-- ── internal helpers ─────────────────────────────────────────────────────────

create function internal.require_profile()
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles
  where id = auth.uid() and is_active;
  if not found then
    raise exception 'no_active_profile' using errcode = 'P0001';
  end if;
  return v_profile;
end;
$$;

-- future skew > 5 min or older than the offline window -> reject
create function internal.validate_device_at(p_device_at timestamptz, p_max_offline interval default interval '72 hours')
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_device_at is null then
    raise exception 'device_timestamp_required' using errcode = 'P0001';
  end if;
  if p_device_at > now() + interval '5 minutes' then
    raise exception 'device_timestamp_in_future' using errcode = 'P0001';
  end if;
  if p_device_at < now() - p_max_offline then
    raise exception 'device_timestamp_too_old' using errcode = 'P0001';
  end if;
end;
$$;

-- idempotent flag append (evidence accumulates, never rewritten)
create function internal.add_shift_flag(p_shift_id uuid, p_flag text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shifts
  set anomaly_flags = array_append(anomaly_flags, p_flag)
  where id = p_shift_id and not (anomaly_flags @> array[p_flag]);
$$;

create function internal.audit(p_company_id uuid, p_actor uuid, p_action text, p_entity text, p_entity_id text, p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (company_id, actor_id, action, entity, entity_id, detail)
  values (p_company_id, p_actor, p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'));
$$;

-- great-circle distance in meters (haversine; good enough for fraud checks)
create function internal.haversine_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ))
$$;

-- monthly partition, created on demand (race-safe via IF NOT EXISTS)
create function internal.ensure_ping_partition(p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date := date_trunc('month', p_at)::date;
  v_name  text := 'location_pings_' || to_char(v_start, 'YYYYMM');
begin
  if to_regclass('public.' || v_name) is null then
    begin
      execute format(
        'create table if not exists public.%I partition of public.location_pings for values from (%L) to (%L)',
        v_name, v_start, (v_start + interval '1 month')::date);
      execute format('alter table public.%I enable row level security', v_name);
    exception when duplicate_table then
      null; -- concurrent creation lost the race; partition exists, which is all we need
    end;
  end if;
end;
$$;

-- ── onboarding ───────────────────────────────────────────────────────────────

-- Called once after OTP sign-in. Binds the new auth user to the company that
-- invited their phone number. Without a claimed invite, RLS denies everything.
create function public.claim_invite()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_phone  text;
  v_invite public.invites;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- idempotent: already onboarded
  select * into v_profile from public.profiles where id = v_uid;
  if found then
    return v_profile;
  end if;

  select phone into v_phone from auth.users where id = v_uid;
  if v_phone is null or v_phone = '' then
    raise exception 'no_phone_on_account' using errcode = 'P0001';
  end if;

  select * into v_invite
  from public.invites
  where regexp_replace(phone_e164, '[^0-9]', '', 'g')
      = regexp_replace(v_phone,     '[^0-9]', '', 'g')
    and claimed_at is null
  for update;

  if not found then
    raise exception 'no_invite' using errcode = 'P0001';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;

  insert into public.profiles (id, company_id, role, full_name, phone_e164)
  values (v_uid, v_invite.company_id, v_invite.role, v_invite.full_name, v_invite.phone_e164)
  returning * into v_profile;

  update public.invites
  set claimed_at = now(), claimed_by = v_uid
  where id = v_invite.id;

  perform internal.audit(v_invite.company_id, v_uid, 'invite_claimed', 'invites', v_invite.id::text,
                         jsonb_build_object('role', v_invite.role));
  return v_profile;
end;
$$;

create function public.record_acknowledgment(p_notice_version text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles := internal.require_profile();
begin
  insert into public.acknowledgments (company_id, worker_id, notice_version)
  values (v_profile.company_id, v_profile.id, p_notice_version)
  on conflict (worker_id, notice_version) do nothing;
end;
$$;

-- ── clock in / clock out ─────────────────────────────────────────────────────

create function public.clock_in(
  p_client_event_id uuid,
  p_device_at       timestamptz,
  p_lat             double precision default null,
  p_lng             double precision default null,
  p_accuracy_m      real default null,
  p_mocked          boolean default false,
  p_device_info     jsonb default '{}'
)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles := internal.require_profile();
  v_shift   public.shifts;
  v_flags   text[] := '{}';
begin
  if p_client_event_id is null then
    raise exception 'client_event_id_required' using errcode = 'P0001';
  end if;

  -- idempotent replay: same event id -> same shift, no new row
  select * into v_shift from public.shifts
  where company_id = v_profile.company_id and client_event_id = p_client_event_id;
  if found then
    return v_shift;
  end if;

  perform internal.validate_device_at(p_device_at);

  if exists (select 1 from public.shifts where worker_id = v_profile.id and status = 'open') then
    raise exception 'shift_already_open' using errcode = 'P0001';
  end if;

  if coalesce(p_mocked, false) then
    v_flags := array_append(v_flags, 'mock_location');
  end if;
  if p_lat is null or p_lng is null then
    v_flags := array_append(v_flags, 'missing_gps');
  elsif p_accuracy_m is not null and p_accuracy_m > 150 then
    v_flags := array_append(v_flags, 'low_accuracy');
  end if;
  if p_device_at < now() - interval '6 hours' then
    v_flags := array_append(v_flags, 'late_sync');
  end if;

  begin
    insert into public.shifts (
      company_id, worker_id, client_event_id,
      clock_in_device_at, clock_in_lat, clock_in_lng,
      clock_in_accuracy_m, clock_in_mocked, device_info, anomaly_flags
    ) values (
      v_profile.company_id, v_profile.id, p_client_event_id,
      p_device_at, p_lat, p_lng,
      p_accuracy_m, coalesce(p_mocked, false), coalesce(p_device_info, '{}'), v_flags
    )
    returning * into v_shift;
  exception
    when unique_violation then
      -- lost a race: either the same event retried concurrently (return it)
      -- or a second open shift (partial unique index) -> proper error
      select * into v_shift from public.shifts
      where company_id = v_profile.company_id and client_event_id = p_client_event_id;
      if found then
        return v_shift;
      end if;
      raise exception 'shift_already_open' using errcode = 'P0001';
  end;

  perform internal.audit(v_profile.company_id, v_profile.id, 'clock_in', 'shifts', v_shift.id::text,
                         jsonb_build_object('sync_lag_s', extract(epoch from now() - p_device_at)::bigint,
                                            'flags', v_flags));
  return v_shift;
end;
$$;

create function public.clock_out(
  p_client_event_id uuid,
  p_device_at       timestamptz,
  p_lat             double precision default null,
  p_lng             double precision default null,
  p_accuracy_m      real default null,
  p_mocked          boolean default false
)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles := internal.require_profile();
  v_shift   public.shifts;
begin
  if p_client_event_id is null then
    raise exception 'client_event_id_required' using errcode = 'P0001';
  end if;

  -- idempotent replay of the same clock-out event
  select * into v_shift from public.shifts
  where company_id = v_profile.company_id and clock_out_client_event_id = p_client_event_id;
  if found then
    return v_shift;
  end if;

  perform internal.validate_device_at(p_device_at);

  select * into v_shift from public.shifts
  where worker_id = v_profile.id and status = 'open'
  for update;
  if not found then
    -- late offline sync: the shift may have been auto-closed while the phone
    -- was dark — honest clock-out evidence must still land, never be lost
    select * into v_shift from public.shifts
    where worker_id = v_profile.id
      and status = 'auto_closed'
      and clock_out_client_event_id is null
      and clock_in_device_at < p_device_at
    order by clock_in_received_at desc
    limit 1
    for update;
    if not found then
      raise exception 'no_open_shift' using errcode = 'P0001';
    end if;
  end if;

  update public.shifts set
    status = 'closed',
    clock_out_client_event_id = p_client_event_id,
    clock_out_device_at   = p_device_at,
    clock_out_received_at = now(),
    clock_out_lat         = p_lat,
    clock_out_lng         = p_lng,
    clock_out_accuracy_m  = p_accuracy_m,
    clock_out_mocked      = coalesce(p_mocked, false)
  where id = v_shift.id
  returning * into v_shift;

  -- the live map must only ever show clocked-in workers
  delete from public.worker_latest_ping where worker_id = v_profile.id;

  -- evidence-preserving anomaly flags (store the truth, flag the weirdness)
  if p_device_at <= v_shift.clock_in_device_at then
    perform internal.add_shift_flag(v_shift.id, 'time_anomaly');
  end if;
  if p_device_at - v_shift.clock_in_device_at > interval '16 hours' then
    perform internal.add_shift_flag(v_shift.id, 'overlong_shift');
  end if;
  if coalesce(p_mocked, false) then
    perform internal.add_shift_flag(v_shift.id, 'mock_location');
  end if;
  if p_lat is null or p_lng is null then
    perform internal.add_shift_flag(v_shift.id, 'missing_gps');
  end if;
  if p_device_at < now() - interval '6 hours' then
    perform internal.add_shift_flag(v_shift.id, 'late_sync');
  end if;

  select * into v_shift from public.shifts where id = v_shift.id;

  perform internal.audit(v_profile.company_id, v_profile.id, 'clock_out', 'shifts', v_shift.id::text,
                         jsonb_build_object('sync_lag_s', extract(epoch from now() - p_device_at)::bigint));
  return v_shift;
end;
$$;

-- ── breadcrumb ingestion ─────────────────────────────────────────────────────

-- p_points: [{"id": uuid, "seq": int, "device_at": ts, "lat": f, "lng": f,
--             "accuracy_m": f, "speed_mps": f, "mocked": bool, "battery_pct": int}, ...]
-- Returns {"accepted": n, "duplicates": n, "rejected": n}.
create function public.sync_location_batch(p_shift_id uuid, p_points jsonb)
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

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_dupes, 'rejected', v_rejected);
end;
$$;

-- ── manager corrections (append-only, evidence preserved) ────────────────────

create function public.adjust_shift(
  p_shift_id  uuid,
  p_field     text,
  p_new_value text,
  p_reason    text
)
returns public.adjustments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile   public.profiles := internal.require_profile();
  v_shift     public.shifts;
  v_old       text;
  v_adjustment public.adjustments;
begin
  if v_profile.role <> 'manager' then
    raise exception 'manager_only' using errcode = 'P0001';
  end if;
  if p_field not in ('clock_in_at', 'clock_out_at', 'status', 'note') then
    raise exception 'invalid_field' using errcode = 'P0001';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;

  select * into v_shift from public.shifts
  where id = p_shift_id and company_id = v_profile.company_id
  for update;
  if not found then
    raise exception 'shift_not_found' using errcode = 'P0001';
  end if;

  if p_field in ('clock_in_at', 'clock_out_at') then
    -- must parse as a timestamp; raises on garbage
    perform p_new_value::timestamptz;
    v_old := case p_field
      when 'clock_in_at'  then v_shift.clock_in_device_at::text
      when 'clock_out_at' then v_shift.clock_out_device_at::text
    end;
  elsif p_field = 'status' then
    if p_new_value not in ('closed', 'disputed') then
      raise exception 'invalid_status' using errcode = 'P0001';
    end if;
    if v_shift.status = 'open' then
      raise exception 'cannot_adjust_open_shift' using errcode = 'P0001';
    end if;
    v_old := v_shift.status;
    update public.shifts set status = p_new_value where id = v_shift.id;
  end if;

  insert into public.adjustments (company_id, shift_id, manager_id, field, old_value, new_value, reason)
  values (v_profile.company_id, v_shift.id, v_profile.id, p_field, v_old, p_new_value, p_reason)
  returning * into v_adjustment;

  perform internal.audit(v_profile.company_id, v_profile.id, 'adjust_shift', 'shifts', v_shift.id::text,
                         jsonb_build_object('field', p_field, 'old', v_old, 'new', p_new_value, 'reason', p_reason));
  return v_adjustment;
end;
$$;

-- ── operator bootstrap (service_role only) ───────────────────────────────────

create function public.create_company_with_manager_invite(
  p_company_name  text,
  p_manager_phone text,
  p_manager_name  text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  insert into public.companies (name) values (p_company_name) returning id into v_company_id;
  insert into public.invites (company_id, phone_e164, role, full_name)
  values (v_company_id, p_manager_phone, 'manager', coalesce(p_manager_name, ''));
  perform internal.audit(v_company_id, null, 'company_created', 'companies', v_company_id::text,
                         jsonb_build_object('name', p_company_name));
  return v_company_id;
end;
$$;

-- ── scheduled maintenance (cron / service_role) ──────────────────────────────

-- shifts open too long are auto-closed with evidence preserved for review
create function public.auto_close_stale_shifts(p_max_shift interval default interval '20 hours')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  with stale as (
    update public.shifts
    set status = 'auto_closed',
        anomaly_flags = (select array_agg(distinct f) from unnest(anomaly_flags || '{auto_closed_no_clock_out}') f)
    where status = 'open' and clock_in_received_at < now() - p_max_shift
    returning id, worker_id
  ),
  cleanup as (
    delete from public.worker_latest_ping
    where worker_id in (select worker_id from stale)
    returning worker_id
  )
  select count(*) into v_count from stale;
  return v_count;
end;
$$;

-- open shifts whose breadcrumbs went quiet: tamper-EVIDENT, not silent
create function public.flag_gap_shifts(p_gap interval default interval '15 minutes')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int := 0;
  v_shift record;
begin
  for v_shift in
    select s.id from public.shifts s
    left join public.worker_latest_ping wlp on wlp.worker_id = s.worker_id and wlp.shift_id = s.id
    where s.status = 'open'
      and s.clock_in_received_at < now() - p_gap          -- grace period after clock-in
      and coalesce(wlp.received_at, s.clock_in_received_at) < now() - p_gap
      and not (s.anomaly_flags @> array['ping_gap'])
  loop
    perform internal.add_shift_flag(v_shift.id, 'ping_gap');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────

revoke all on function public.claim_invite() from public;
revoke all on function public.record_acknowledgment(text) from public;
revoke all on function public.clock_in(uuid, timestamptz, double precision, double precision, real, boolean, jsonb) from public;
revoke all on function public.clock_out(uuid, timestamptz, double precision, double precision, real, boolean) from public;
revoke all on function public.sync_location_batch(uuid, jsonb) from public;
revoke all on function public.adjust_shift(uuid, text, text, text) from public;
revoke all on function public.create_company_with_manager_invite(text, text, text) from public;
revoke all on function public.auto_close_stale_shifts(interval) from public;
revoke all on function public.flag_gap_shifts(interval) from public;

grant execute on function public.claim_invite() to authenticated;
grant execute on function public.record_acknowledgment(text) to authenticated;
grant execute on function public.clock_in(uuid, timestamptz, double precision, double precision, real, boolean, jsonb) to authenticated;
grant execute on function public.clock_out(uuid, timestamptz, double precision, double precision, real, boolean) to authenticated;
grant execute on function public.sync_location_batch(uuid, jsonb) to authenticated;
grant execute on function public.adjust_shift(uuid, text, text, text) to authenticated;

grant execute on function public.create_company_with_manager_invite(text, text, text) to service_role;
grant execute on function public.auto_close_stale_shifts(interval) to service_role;
grant execute on function public.flag_gap_shifts(interval) to service_role;
