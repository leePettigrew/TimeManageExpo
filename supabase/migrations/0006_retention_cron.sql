-- 0006_retention_cron.sql — GDPR retention + scheduled maintenance.
-- Raw breadcrumbs are purged after 90 days (Irish DPC norm for employee
-- location data); computed hour totals live in shifts and survive the purge.

-- Drop monthly partitions wholly older than the cutoff; scrub stragglers in
-- the default partition. Partition drops are instant; no giant DELETEs.
create function public.purge_old_pings(p_retention_days int default 90)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - make_interval(days => p_retention_days);
  v_dropped int := 0;
  v_part record;
  v_upper timestamptz;
begin
  for v_part in
    select c.relname,
           pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_class c
    join pg_inherits i on i.inhrelid = c.oid
    join pg_class parent on parent.oid = i.inhparent
    join pg_namespace n on n.oid = parent.relnamespace
    where parent.relname = 'location_pings' and n.nspname = 'public'
      and c.relname <> 'location_pings_default'
  loop
    -- bound looks like: FOR VALUES FROM ('2026-06-01...') TO ('2026-07-01...')
    v_upper := (regexp_match(v_part.bound, $re$TO \('([^']+)'\)$re$))[1]::timestamptz;
    if v_upper is not null and v_upper <= v_cutoff then
      execute format('drop table public.%I', v_part.relname);
      v_dropped := v_dropped + 1;
    end if;
  end loop;

  delete from public.location_pings_default where received_at < v_cutoff;

  -- the live-map row is location data too: same retention clock
  delete from public.worker_latest_ping where received_at < v_cutoff;

  -- keep the next month's partition ready so ingest never falls to default
  perform internal.ensure_ping_partition(now());
  perform internal.ensure_ping_partition(now() + interval '1 month');

  return v_dropped;
end;
$$;

revoke all on function public.purge_old_pings(int) from public;
grant execute on function public.purge_old_pings(int) to service_role;

-- Schedule jobs when pg_cron is available (Supabase image has it; vanilla test
-- Postgres does not — everything above stays manually callable).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-old-pings',       '15 3 * * *',  $job$select public.purge_old_pings()$job$);
    perform cron.schedule('auto-close-stale',      '5 * * * *',   $job$select public.auto_close_stale_shifts()$job$);
    perform cron.schedule('flag-gap-shifts',       '*/5 * * * *', $job$select public.flag_gap_shifts()$job$);
  end if;
end
$$;

-- Defense in depth: Postgres grants EXECUTE to PUBLIC on new functions by
-- default. The internal schema is not exposed through PostgREST, but no client
-- role should be able to call SECURITY DEFINER helpers under any future
-- configuration either. Only the two RLS policy helpers stay callable.
revoke all on all functions in schema internal from public, anon, authenticated;
grant execute on function internal.current_company_id() to authenticated;
grant execute on function internal.is_manager() to authenticated;

-- current + next month partitions so the first sync never lands in default
select internal.ensure_ping_partition(now());
select internal.ensure_ping_partition(now() + interval '1 month');
