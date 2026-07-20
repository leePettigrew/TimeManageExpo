-- 0011_billing.sql — subscriptions, 14-day trial, self-serve manager signup,
-- and access gating. Managers sign in with email/Google and create their own
-- company (self-serve SaaS); it starts a 14-day trial; after that, without an
-- active Stripe subscription the company goes READ-ONLY (view history, but no
-- new shifts / worker invites / adjustments).

alter table companies
  add column subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  add column trial_ends_at        timestamptz not null default now() + interval '14 days',
  add column stripe_customer_id   text,
  add column stripe_subscription_id text,
  add column current_period_end   timestamptz,
  add column seats                int not null default 0;

-- A company can operate (run live tracking, add workers, adjust) when it is on
-- an unexpired trial OR has an active paid subscription.
create function internal.company_is_active(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.companies c
    where c.id = p_company_id
      and (
        c.subscription_status = 'active'
        or (c.subscription_status = 'trialing' and c.trial_ends_at > now())
        or (c.subscription_status = 'past_due' and c.current_period_end > now())
      )
  )
$$;

grant execute on function internal.company_is_active(uuid) to authenticated;

-- Active-worker count drives per-seat billing.
create function internal.active_worker_count(p_company_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.profiles
  where company_id = p_company_id and role = 'worker' and is_active
$$;

-- ── self-serve manager signup ────────────────────────────────────────────────

-- A newly-authenticated user (email/Google, no profile yet) creates their own
-- company and becomes its manager, starting the trial. This is the self-serve
-- path; the operator/invite path (claim_invite) still works too.
create function public.create_company_and_join(p_company_name text, p_full_name text default '')
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_company_id uuid;
  v_profile public.profiles;
  v_phone   text;
  v_email   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- idempotent: already onboarded
  select * into v_profile from public.profiles where id = v_uid;
  if found then
    return v_profile;
  end if;

  if p_company_name is null or length(trim(p_company_name)) < 2 then
    raise exception 'company_name_required' using errcode = 'P0001';
  end if;

  select phone, email into v_phone, v_email from auth.users where id = v_uid;

  insert into public.companies (name) values (trim(p_company_name)) returning id into v_company_id;

  -- profiles.phone_e164 is NOT NULL UNIQUE; email/Google managers have no
  -- phone, so store a stable non-conflicting placeholder derived from the uid
  insert into public.profiles (id, company_id, role, full_name, phone_e164)
  values (
    v_uid, v_company_id, 'manager', coalesce(nullif(trim(p_full_name), ''), split_part(coalesce(v_email, ''), '@', 1)),
    coalesce(v_phone, 'noemail:' || v_uid::text)
  )
  returning * into v_profile;

  perform internal.audit(v_company_id, v_uid, 'company_self_created', 'companies', v_company_id::text,
                         jsonb_build_object('name', p_company_name, 'email', v_email));
  return v_profile;
end;
$$;

revoke all on function public.create_company_and_join(text, text) from public;
grant execute on function public.create_company_and_join(text, text) to authenticated;

-- expose the caller's own company billing state to the dashboard
create view v_my_company
with (security_invoker = on)
as
select c.id, c.name, c.subscription_status, c.trial_ends_at, c.current_period_end,
       c.seats, c.stripe_customer_id is not null as has_customer,
       internal.company_is_active(c.id) as is_active,
       internal.active_worker_count(c.id) as active_workers
from companies c
where c.id = (select internal.current_company_id());

grant select on v_my_company to authenticated;

-- ── gating: block manager mutations + new clock-ins when inactive ────────────

-- New worker invites require an active company (managers can still view).
drop policy if exists invites_insert on invites;
create policy invites_insert on invites for insert to authenticated
  with check (
    company_id = (select internal.current_company_id())
    and (select internal.is_manager())
    and created_by = auth.uid()
    and claimed_at is null
    and claimed_by is null
    and (select internal.company_is_active(company_id))
  );

-- clock_in gated: an inactive company cannot START new shifts (workers can
-- still clock OUT and sync existing data, so nobody is stranded mid-shift).
create or replace function public.clock_in(
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

  -- subscription gate: no new shifts for a lapsed company (clock-out still works)
  if not internal.company_is_active(v_profile.company_id) then
    raise exception 'company_inactive' using errcode = 'P0001';
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

-- adjust_shift gated on active company (managers can't edit on a lapsed plan)
create or replace function public.adjust_shift(
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
  if not internal.company_is_active(v_profile.company_id) then
    raise exception 'company_inactive' using errcode = 'P0001';
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

-- ── stripe state sync (called by the billing webhook via service_role) ───────

create function public.billing_sync(
  p_company_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_seats int
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.companies set
    stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
    stripe_subscription_id = coalesce(p_subscription_id, stripe_subscription_id),
    subscription_status = coalesce(p_status, subscription_status),
    current_period_end = coalesce(p_current_period_end, current_period_end),
    seats = coalesce(p_seats, seats)
  where id = p_company_id;
  perform internal.audit(p_company_id, null, 'billing_sync', 'companies', p_company_id::text,
                         jsonb_build_object('status', p_status, 'seats', p_seats));
end;
$$;

revoke all on function public.billing_sync(uuid, text, text, text, timestamptz, int) from public;
grant execute on function public.billing_sync(uuid, text, text, text, timestamptz, int) to service_role;

grant execute on function internal.active_worker_count(uuid) to service_role;
