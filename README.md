# TimeTable

Time & location tracking for field crews (Ireland). Workers clock in/out on
their phones; GPS breadcrumbs are recorded **only while clocked in**; managers
see live status, routes, and payroll-ready hour totals. Built to be
tamper-evident: server-authoritative timestamps, append-only records, anomaly
flags instead of silent trust.

## Layout

| Path | What |
|---|---|
| `app/` | Worker + manager mobile app (Expo / React Native, TypeScript) |
| `dashboard/` | Manager web dashboard (Vite + React, MapLibre map) |
| `supabase/migrations/` | The entire backend: schema, RLS tenant isolation, RPC write path, views, retention |
| `supabase/docker/` | Self-hosted Supabase stack for Unraid (see `README-unraid.md` there) |
| `supabase/tests/` | DB contract tests — run against a real embedded Postgres |
| `supabase/seed/simulate-day.mjs` | Replays a full working day against a running stack |
| `docs/` | Privacy notice template (GDPR) |

## Architecture in one paragraph

Everything stateful lives in Postgres (self-hosted Supabase). Clients hold no
authority: phones and browsers get **zero direct write access** to event
tables — clock-ins, clock-outs, and GPS batches go through `SECURITY DEFINER`
RPCs that stamp server time, enforce the shift state machine, and dedupe on
client-generated UUIDv7 ids, so offline retries are harmless. Row-Level
Security keyed on `company_id` isolates companies from each other at the
database engine. The mobile app is outbox-first: every event is written to
on-device SQLite, then synced when signal allows; nothing is ever lost to a
dead zone. Location trails purge automatically after 90 days (GDPR); hour
totals stay.

## Development

```bash
# database tests (no Docker needed — spins up an embedded Postgres)
cd supabase/tests && npm install && npm test

# dashboard (needs a running stack; copy .env.example → .env first)
cd dashboard && npm install && npm run dev

# mobile app (needs a dev build — background location never runs in Expo Go)
cd app && npm install && npx expo prebuild && npx expo run:android
```

Backend deployment: `supabase/docker/README-unraid.md`. Development sign-in
without Twilio: phone `+353870000000`, code `123456` (GoTrue test OTP).

## Non-negotiables (read before changing code)

1. **Tracking hard-stops at clock-out.** GDPR + store review + trust all
   depend on it. Never add tracking outside an open shift.
2. **No client writes to event tables.** New write paths go through RPCs with
   server timestamps and idempotency keys.
3. **Evidence is append-only.** Corrections are `adjustments` rows; original
   records are never mutated.
4. **Flag, don't block.** GPS weirdness (mocked, low accuracy, gaps) is
   recorded and surfaced to managers — honest workers with flaky phones must
   never be locked out of clocking in.
5. **RLS tests must stay green.** `supabase/tests` asserts cross-tenant reads
   and writes fail on every table; run it after any migration change.
