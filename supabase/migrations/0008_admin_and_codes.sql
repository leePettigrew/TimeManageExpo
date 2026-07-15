-- 0008_admin_and_codes.sql — operator (super-admin) role + invite-code
-- onboarding (SMS-free sign-up).
--
-- Operator: a person flagged is_operator=true (set once by the host owner via
-- psql). Operators read everything across companies and manage companies /
-- people through auditable RPCs — no service key ever reaches a browser.
--
-- Invite codes: every invite carries a 6-digit one-time code. A new worker
-- signs in anonymously (no SMS) and claims the invite with phone + code.
-- Wrong-code attempts are counted WITHOUT raising (a raise would roll the
-- counter back); the RPC returns NULL for a bad code and locks after 10.

-- ── operator role ────────────────────────────────────────────────────────────

alter table profiles add column is_operator boolean not null default false;

create function internal.is_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_operator and is_active
  )
$$;

revoke all on function internal.is_operator() from public;
grant execute on function internal.is_operator() to authenticated;

-- read-everything policies (permissive policies OR together with existing ones)
create policy companies_operator_select on companies for select to authenticated
  using ((select internal.is_operator()));
create policy profiles_operator_select on profiles for select to authenticated
  using ((select internal.is_operator()));
create policy invites_operator_select on invites for select to authenticated
  using ((select internal.is_operator()));
create policy acknowledgments_operator_select on acknowledgments for select to authenticated
  using ((select internal.is_operator()));
create policy shifts_operator_select on shifts for select to authenticated
  using ((select internal.is_operator()));
create policy location_pings_operator_select on location_pings for select to authenticated
  using ((select internal.is_operator()));
create policy worker_latest_ping_operator_select on worker_latest_ping for select to authenticated
  using ((select internal.is_operator()));
create policy adjustments_operator_select on adjustments for select to authenticated
  using ((select internal.is_operator()));
create policy audit_log_operator_select on audit_log for select to authenticated
  using ((select internal.is_operator()));
create policy location_requests_operator_select on location_requests for select to authenticated
  using ((select internal.is_operator()));

-- ── operator management RPCs (auditable; no direct writes) ───────────────────

create function internal.require_operator()
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
  where id = auth.uid() and is_operator and is_active;
  if not found then
    raise exception 'operator_only' using errcode = 'P0001';
  end if;
  return v_profile;
end;
$$;

create function public.admin_create_company(
  p_name text,
  p_manager_phone text,
  p_manager_name text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator public.profiles := internal.require_operator();
  v_company_id uuid;
begin
  if p_name is null or length(trim(p_name)) < 2 then
    raise exception 'company_name_required' using errcode = 'P0001';
  end if;
  insert into public.companies (name) values (trim(p_name)) returning id into v_company_id;
  insert into public.invites (company_id, phone_e164, role, full_name)
  values (v_company_id, p_manager_phone, 'manager', coalesce(p_manager_name, ''));
  perform internal.audit(v_company_id, v_operator.id, 'company_created', 'companies',
                         v_company_id::text, jsonb_build_object('name', p_name, 'by', 'operator'));
  return v_company_id;
end;
$$;

create function public.admin_rename_company(p_company_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator public.profiles := internal.require_operator();
begin
  update public.companies set name = trim(p_name) where id = p_company_id;
  if not found then
    raise exception 'company_not_found' using errcode = 'P0001';
  end if;
  perform internal.audit(p_company_id, v_operator.id, 'company_renamed', 'companies',
                         p_company_id::text, jsonb_build_object('name', p_name));
end;
$$;

create function public.admin_set_profile_active(p_profile_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator public.profiles := internal.require_operator();
  v_target public.profiles;
begin
  update public.profiles set is_active = p_active where id = p_profile_id
  returning * into v_target;
  if not found then
    raise exception 'profile_not_found' using errcode = 'P0001';
  end if;
  perform internal.audit(v_target.company_id, v_operator.id, 'profile_active_set', 'profiles',
                         p_profile_id::text, jsonb_build_object('active', p_active));
end;
$$;

create function public.admin_cancel_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator public.profiles := internal.require_operator();
  v_invite public.invites;
begin
  delete from public.invites where id = p_invite_id and claimed_at is null
  returning * into v_invite;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0001';
  end if;
  perform internal.audit(v_invite.company_id, v_operator.id, 'invite_cancelled', 'invites',
                         p_invite_id::text, jsonb_build_object('phone', v_invite.phone_e164));
end;
$$;

revoke all on function public.admin_create_company(text, text, text) from public;
revoke all on function public.admin_rename_company(uuid, text) from public;
revoke all on function public.admin_set_profile_active(uuid, boolean) from public;
revoke all on function public.admin_cancel_invite(uuid) from public;
grant execute on function public.admin_create_company(text, text, text) to authenticated;
grant execute on function public.admin_rename_company(uuid, text) to authenticated;
grant execute on function public.admin_set_profile_active(uuid, boolean) to authenticated;
grant execute on function public.admin_cancel_invite(uuid) to authenticated;

-- ── invite codes (SMS-free onboarding) ───────────────────────────────────────

alter table invites
  add column code text not null default lpad(floor(random() * 1000000)::int::text, 6, '0');
alter table invites
  add column code_attempts int not null default 0;

-- A new user signs in ANONYMOUSLY (no SMS), then claims with phone + code.
-- Returns the new profile, or NULL when the code is wrong/locked — never a
-- raise for a bad code, so the attempt counter commits.
create function public.claim_invite_with_code(p_phone text, p_code text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_digits  text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_invite  public.invites;
  v_profile public.profiles;
  v_old     public.profiles;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- idempotent: already onboarded
  select * into v_profile from public.profiles where id = v_uid;
  if found then
    return v_profile;
  end if;

  if length(v_digits) < 9 then
    raise exception 'phone_required' using errcode = 'P0001';
  end if;
  -- Irish local format → E.164 digits (087 123 4567 → 353871234567)
  if v_digits like '08%' and length(v_digits) = 10 then
    v_digits := '353' || substr(v_digits, 2);
  end if;

  select * into v_invite from public.invites
  where regexp_replace(phone_e164, '[^0-9]', '', 'g') = v_digits
    and claimed_at is null
  for update;
  if not found then
    raise exception 'no_invite' using errcode = 'P0001';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;

  if v_invite.code_attempts >= 10 or v_invite.code <> trim(coalesce(p_code, '')) then
    update public.invites set code_attempts = code_attempts + 1 where id = v_invite.id;
    return null; -- wrong or locked; counter persists because we do not raise
  end if;

  -- a previously deactivated profile may hold this phone number; retire it
  select * into v_old from public.profiles where phone_e164 = v_invite.phone_e164;
  if found then
    if v_old.is_active then
      raise exception 'phone_already_registered' using errcode = 'P0001';
    end if;
    update public.profiles
    set phone_e164 = phone_e164 || '#retired#' || substr(v_old.id::text, 1, 8)
    where id = v_old.id;
  end if;

  insert into public.profiles (id, company_id, role, full_name, phone_e164)
  values (v_uid, v_invite.company_id, v_invite.role, v_invite.full_name, v_invite.phone_e164)
  returning * into v_profile;

  update public.invites set claimed_at = now(), claimed_by = v_uid where id = v_invite.id;

  perform internal.audit(v_invite.company_id, v_uid, 'invite_claimed_with_code', 'invites',
                         v_invite.id::text, jsonb_build_object('role', v_invite.role));
  return v_profile;
end;
$$;

revoke all on function public.claim_invite_with_code(text, text) from public;
grant execute on function public.claim_invite_with_code(text, text) to authenticated;
