-- 0005_views.sql — effective times + timesheets.
-- security_invoker: views run under the caller's RLS, so workers see their own
-- rows and managers their company's — same rules as the base tables.
-- Hours are computed from device capture times (when work actually happened),
-- overridden by the latest manager adjustment per field; originals stay intact.

create view v_shift_effective
with (security_invoker = on)
as
with latest_adj as (
  select distinct on (shift_id, field)
    shift_id, field, new_value
  from adjustments
  where field in ('clock_in_at', 'clock_out_at')
  order by shift_id, field, created_at desc
)
select
  s.id,
  s.company_id,
  s.worker_id,
  p.full_name,
  s.status,
  s.clock_in_device_at,
  s.clock_in_received_at,
  s.clock_in_lat, s.clock_in_lng, s.clock_in_accuracy_m, s.clock_in_mocked,
  s.clock_out_device_at,
  s.clock_out_received_at,
  s.clock_out_lat, s.clock_out_lng, s.clock_out_accuracy_m, s.clock_out_mocked,
  coalesce(adj_in.new_value::timestamptz,  s.clock_in_device_at)  as effective_clock_in_at,
  coalesce(adj_out.new_value::timestamptz, s.clock_out_device_at) as effective_clock_out_at,
  case
    when coalesce(adj_out.new_value::timestamptz, s.clock_out_device_at) is not null then
      greatest(0, extract(epoch from
        coalesce(adj_out.new_value::timestamptz, s.clock_out_device_at)
        - coalesce(adj_in.new_value::timestamptz, s.clock_in_device_at)))::bigint
  end as worked_seconds,
  (adj_in.shift_id is not null or adj_out.shift_id is not null) as is_adjusted,
  s.anomaly_flags,
  cardinality(s.anomaly_flags) > 0 as is_flagged,
  extract(epoch from s.clock_in_received_at - s.clock_in_device_at)::bigint as clock_in_sync_lag_s,
  s.device_info,
  s.created_at
from shifts s
join profiles p on p.id = s.worker_id
left join latest_adj adj_in  on adj_in.shift_id  = s.id and adj_in.field  = 'clock_in_at'
left join latest_adj adj_out on adj_out.shift_id = s.id and adj_out.field = 'clock_out_at';

create view v_timesheet_daily
with (security_invoker = on)
as
select
  company_id,
  worker_id,
  full_name,
  (effective_clock_in_at at time zone 'Europe/Dublin')::date as work_date,
  count(*)                                   as shift_count,
  sum(worked_seconds)                        as worked_seconds,
  round(sum(worked_seconds) / 3600.0, 2)     as worked_hours,
  count(*) filter (where is_flagged)         as flagged_shifts,
  count(*) filter (where status = 'open')    as open_shifts,
  bool_or(is_adjusted)                       as has_adjustments
from v_shift_effective
group by company_id, worker_id, full_name, (effective_clock_in_at at time zone 'Europe/Dublin')::date;

create view v_timesheet_weekly
with (security_invoker = on)
as
select
  company_id,
  worker_id,
  full_name,
  extract(isoyear from effective_clock_in_at at time zone 'Europe/Dublin')::int as iso_year,
  extract(week    from effective_clock_in_at at time zone 'Europe/Dublin')::int as iso_week,
  min((effective_clock_in_at at time zone 'Europe/Dublin')::date)               as week_starts,
  count(*)                               as shift_count,
  sum(worked_seconds)                    as worked_seconds,
  round(sum(worked_seconds) / 3600.0, 2) as worked_hours,
  count(*) filter (where is_flagged)     as flagged_shifts,
  bool_or(is_adjusted)                   as has_adjustments
from v_shift_effective
group by company_id, worker_id, full_name,
  extract(isoyear from effective_clock_in_at at time zone 'Europe/Dublin'),
  extract(week    from effective_clock_in_at at time zone 'Europe/Dublin');

grant select on v_shift_effective, v_timesheet_daily, v_timesheet_weekly to authenticated;
