-- 0003_rls.sql — tenant isolation.
-- Helpers are SECURITY DEFINER so policies can consult profiles without RLS
-- recursion. Policies are default-deny: RLS is enabled on every table and only
-- the policies below open access. Event tables additionally have no write
-- grants at all — a policy bug alone can never allow a client write.

create function internal.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select company_id from public.profiles
  where id = auth.uid() and is_active
$$;

create function internal.is_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager' and is_active
  )
$$;

-- policies call these a lot; keep them cheap and grant execute narrowly
revoke all on function internal.current_company_id() from public;
revoke all on function internal.is_manager() from public;
grant execute on function internal.current_company_id() to authenticated;
grant execute on function internal.is_manager() to authenticated;
grant usage on schema internal to authenticated;

alter table companies          enable row level security;
alter table profiles           enable row level security;
alter table invites            enable row level security;
alter table acknowledgments    enable row level security;
alter table shifts             enable row level security;
alter table location_pings     enable row level security;
alter table location_pings_default enable row level security;
alter table worker_latest_ping enable row level security;
alter table adjustments        enable row level security;
alter table audit_log          enable row level security;

-- ── companies ────────────────────────────────────────────────────────────────
grant select on companies to authenticated;
create policy companies_select on companies for select to authenticated
  using (id = (select internal.current_company_id()));

-- ── profiles ─────────────────────────────────────────────────────────────────
-- workers see themselves; managers see their whole company
grant select on profiles to authenticated;
create policy profiles_select on profiles for select to authenticated
  using (
    id = auth.uid()
    or (company_id = (select internal.current_company_id())
        and (select internal.is_manager()))
  );

-- managers may deactivate/rename people in their company (not fraud-critical);
-- column-level grant keeps role/company/phone immutable from clients
grant update (full_name, is_active) on profiles to authenticated;
create policy profiles_update on profiles for update to authenticated
  using (company_id = (select internal.current_company_id())
         and (select internal.is_manager()))
  with check (company_id = (select internal.current_company_id()));

-- ── invites ──────────────────────────────────────────────────────────────────
-- managers run their own crew onboarding directly
grant select, insert, delete on invites to authenticated;
create policy invites_select on invites for select to authenticated
  using (company_id = (select internal.current_company_id())
         and (select internal.is_manager()));
create policy invites_insert on invites for insert to authenticated
  with check (
    company_id = (select internal.current_company_id())
    and (select internal.is_manager())
    and created_by = auth.uid()
    and claimed_at is null
    and claimed_by is null
  );
create policy invites_delete on invites for delete to authenticated
  using (company_id = (select internal.current_company_id())
         and (select internal.is_manager())
         and claimed_at is null);

-- ── acknowledgments ──────────────────────────────────────────────────────────
grant select on acknowledgments to authenticated;
create policy acknowledgments_select on acknowledgments for select to authenticated
  using (
    worker_id = auth.uid()
    or (company_id = (select internal.current_company_id())
        and (select internal.is_manager()))
  );

-- ── shifts (append-only ledger: read-only for clients) ───────────────────────
grant select on shifts to authenticated;
create policy shifts_select on shifts for select to authenticated
  using (
    worker_id = auth.uid()
    or (company_id = (select internal.current_company_id())
        and (select internal.is_manager()))
  );

-- ── location_pings (read-only for clients) ───────────────────────────────────
grant select on location_pings to authenticated;
create policy location_pings_select on location_pings for select to authenticated
  using (
    worker_id = auth.uid()
    or (company_id = (select internal.current_company_id())
        and (select internal.is_manager()))
  );

-- ── worker_latest_ping (read-only for clients) ───────────────────────────────
grant select on worker_latest_ping to authenticated;
create policy worker_latest_ping_select on worker_latest_ping for select to authenticated
  using (
    worker_id = auth.uid()
    or (company_id = (select internal.current_company_id())
        and (select internal.is_manager()))
  );

-- ── adjustments (written via RPC only; managers read their company's) ────────
grant select on adjustments to authenticated;
create policy adjustments_select on adjustments for select to authenticated
  using (
    company_id = (select internal.current_company_id())
    and ((select internal.is_manager()) or exists (
      select 1 from shifts s where s.id = shift_id and s.worker_id = auth.uid()
    ))
  );

-- ── audit_log (managers read their company's) ────────────────────────────────
grant select on audit_log to authenticated;
create policy audit_log_select on audit_log for select to authenticated
  using (company_id = (select internal.current_company_id())
         and (select internal.is_manager()));
