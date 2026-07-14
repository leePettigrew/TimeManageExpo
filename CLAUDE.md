# TimeTable — project notes for Claude

Read `README.md` first, especially **Non-negotiables** — tracking hard-stops at
clock-out, no client writes to event tables, append-only evidence, flag-don't-
block, RLS tests stay green.

- Three independent packages (NOT npm workspaces — Expo/Metro monorepo pitfalls
  avoided on purpose): `app/` (Expo SDK 57), `dashboard/` (Vite React),
  `supabase/tests/` (DB contract tests).
- The backend is entirely SQL: `supabase/migrations/*.sql`, applied in filename
  order. After ANY migration change run `cd supabase/tests && npm test` —
  it spins up an embedded Postgres (no Docker needed) with a Supabase shim.
- Mobile background location requires an EAS/dev build; Expo Go cannot run
  TaskManager. `app/AGENTS.md` points at the SDK 57 docs — verify APIs there.
- Deployment target is the user's Unraid server: `supabase/docker/` +
  `README-unraid.md`. Dev sign-in without Twilio: phone `+353870000000`,
  OTP `123456`.
- Full-stack smoke test after deploy: `supabase/seed/simulate-day.mjs`.
