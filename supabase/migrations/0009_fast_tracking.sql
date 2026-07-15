-- 0009_fast_tracking.sql — allow sub-minute ping intervals (down to 5s).
-- High-resolution / near-real-time tracking for jobs that need it. Heavy on
-- battery and row volume (5s ≈ 7k points per 10h shift) — surfaced as a
-- clearly-labelled option in the dashboard, not the default.

alter table profiles drop constraint if exists profiles_ping_interval_s_check;
alter table profiles add constraint profiles_ping_interval_s_check
  check (ping_interval_s between 5 and 900);
