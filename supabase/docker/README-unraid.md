# TimeTable — self-hosted Supabase on Unraid

Trimmed Supabase stack (pinned to the official self-hosting files, master as
of 2026-07) providing exactly what the TimeTable apps need:

| Service  | Image                                  | Purpose                                |
|----------|----------------------------------------|----------------------------------------|
| db       | `supabase/postgres:17.6.1.136`         | Postgres + Supabase roles/extensions   |
| auth     | `supabase/gotrue:v2.189.0`             | Phone OTP sign-in                      |
| rest     | `postgrest/postgrest:v14.12`           | Tables + RPCs over HTTP                |
| realtime | `supabase/realtime:v2.102.3`           | Postgres Changes (`shifts`, `worker_latest_ping`) |
| kong     | `kong/kong:3.9.1`                      | Gateway — the ONLY published port      |
| studio   | `supabase/studio:2026.07.07-sha-a6a04f2` | Admin dashboard                      |
| meta     | `supabase/postgres-meta:v0.96.6`       | Studio's DB introspection backend      |

Excluded: storage/imgproxy (no file uploads), edge functions, supavisor
pooler, analytics/vector (not part of the official base compose any more).

Everything below happens in an Unraid terminal (web UI ➜ `>_` icon, or SSH).

---

## 1. Install prerequisites (once)

* Unraid 6.12+ with Docker enabled.
* **Docker Compose Manager** plugin from Community Applications (gives you
  the `docker compose` command), or any other way to run `docker compose`.

## 2. Put the stack on the server

Copy the whole `supabase/` folder from this repo (both `docker/` and
`migrations/` — the migration script expects them side by side) to the
array, e.g.:

```sh
mkdir -p /mnt/user/appdata/timetable/stack
# from your workstation (or use the Unraid file manager / SMB share):
# scp -r supabase root@tower:/mnt/user/appdata/timetable/stack
cd /mnt/user/appdata/timetable/stack/supabase/docker
```

Create the data folders (Docker would create them as root anyway, but being
explicit keeps ownership obvious):

```sh
mkdir -p /mnt/user/appdata/timetable/db/data \
         /mnt/user/appdata/timetable/studio/snippets \
         /mnt/user/appdata/timetable/studio/edge-functions
```

(Postgres's `/etc/postgresql-custom` key material lives in a Docker named
volume, not under `DATA_DIR` — it must copy its defaults out of the image on
first use, which only named volumes do.)

Postgres data benefits massively from living on the cache pool (SSD). If
`appdata` is a cache-preferred share (the Unraid default) you are done;
otherwise point `DATA_DIR` somewhere SSD-backed.

## 3. Configure `.env`

```sh
cp .env.example .env
# Unraid has no Node — run the key generator in a throwaway container:
docker run --rm -v "$PWD":/w -w /w node:22-alpine node generate-keys.mjs
```

Paste the printed block into `.env` (replacing the CHANGE-ME values), then
review the rest of the file:

* `DATA_DIR` — leave as `/mnt/user/appdata/timetable` unless you moved it.
* `SUPABASE_PUBLIC_URL`, `API_EXTERNAL_URL`, `SITE_URL` — LAN IP for now;
  switch to your tunnel hostnames later (step 8).
* `SMS_TEST_OTP=353870000000:123456` — the dev sign-in: phone
  `+353 87 000 0000`, code `123456`, no Twilio needed. Note the phone is
  listed **without** the leading `+`.

**Important:** `POSTGRES_PASSWORD` and `JWT_SECRET` are baked into the
database on first boot. Get them right before the first `up -d`.

## 4. Start the stack

```sh
docker compose up -d
watch docker compose ps        # wait until every service is healthy/running
```

First boot takes a few minutes: the db image initialises Postgres, then
GoTrue and Realtime run their own internal migrations.

## 5. Apply the app schema

Migrations are applied **after** boot on purpose — GoTrue must have created
its final `auth.users` shape first, and `pg_cron` needs to be enabled before
`0006_retention_cron.sql` schedules the retention jobs (the script handles
both, and is idempotent — safe to re-run):

```sh
sh apply-migrations.sh
```

It finishes by listing the scheduled cron jobs — you should see
`purge-old-pings`, `auto-close-stale`, and `flag-gap-shifts`.

## 6. Health checks

```sh
source .env    # for $ANON_KEY / $SERVICE_ROLE_KEY below

# Kong + GoTrue
curl -s http://localhost:8000/auth/v1/health -H "apikey: $ANON_KEY"
# -> {"version":...,"name":"GoTrue",...}

# PostgREST (OpenAPI root is admin-only by design)
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:8000/rest/v1/ -H "apikey: $SERVICE_ROLE_KEY"   # -> 200
curl -s http://localhost:8000/rest/v1/companies -H "apikey: $ANON_KEY"
# -> [] (RLS: anon sees nothing — but the route works)

# Realtime (health endpoint is not routed through Kong; ask Docker)
docker inspect --format '{{.State.Health.Status}}' realtime-dev.supabase-realtime
# -> healthy

# Database
docker exec supabase-db pg_isready -U postgres -h localhost   # -> accepting

# Studio: browse to http://<unraid-ip>:8000 and log in with
# DASHBOARD_USERNAME / DASHBOARD_PASSWORD from .env
```

Smoke-test the dev phone OTP end to end:

```sh
curl -s -X POST http://localhost:8000/auth/v1/otp \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"phone":"+353870000000"}'
# -> {} (no SMS is sent; the code is the fixed test OTP)

curl -s -X POST http://localhost:8000/auth/v1/verify \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"type":"sms","phone":"+353870000000","token":"123456"}'
# -> {"access_token":"...","refresh_token":"...",...}
```

## 7. Create the first company + manager invite

The bootstrap RPC is `service_role`-only. Simplest — psql inside the
container:

```sh
docker exec supabase-db psql -U postgres -d postgres -c \
  "select public.create_company_with_manager_invite('Acme Groundworks Ltd', '+353871234567', 'Mary Manager');"
```

Or over the API with the service key:

```sh
curl -s -X POST http://localhost:8000/rest/v1/rpc/create_company_with_manager_invite \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_company_name":"Acme Groundworks Ltd","p_manager_phone":"+353871234567","p_manager_name":"Mary Manager"}'
```

Both return the new company UUID. The manager then signs into the dashboard
with that phone number (OTP), the app calls `claim_invite()`, and from there
they invite workers themselves. Invite phone numbers must be E.164
(`+353...`) to match GoTrue's stored phone.

### Make yourself the operator (super-admin)

Once you (the host owner) have signed into the dashboard at least once — so you
have a `profiles` row — promote it. This unlocks the **Admin** tab: create /
rename companies, deactivate anyone, view all invite codes and audit activity,
all without touching psql again.

```sh
docker exec supabase-db psql -U postgres -d postgres -c \
  "update profiles set is_operator = true where phone_e164 = '+353871234567';"
```

Refresh the dashboard and the **Admin** tab appears. From then on, new companies
are two clicks in the Admin console — the manager invite code shows right there
to hand to the boss.

### Invite codes (SMS-free onboarding)

Every invite carries a **6-digit code** shown in the Team tab (and the Admin
console). A new worker opens the app, taps **"I have an invite code"**, and
enters their number + the code — no SMS is sent. This needs anonymous sign-in
enabled (`ENABLE_ANONYMOUS_USERS=true`, the default in `.env.example`). An
anonymous session that hasn't claimed an invite can read nothing — RLS denies
everything until `claim_invite_with_code` binds it to a company.

## 8. Expose it with a free Cloudflare Tunnel

Kong (port `8000`) is the single entry point — never port-forward it or the
db. Use a tunnel:

1. Add your domain to Cloudflare (free plan is fine).
2. Zero Trust ➜ Networks ➜ Tunnels ➜ **Create a tunnel** (Cloudflared).
   Copy the token.
3. Install **cloudflared** from Unraid Community Applications and paste the
   tunnel token (or run:
   `docker run -d --restart unless-stopped cloudflare/cloudflared:latest tunnel run --token <TOKEN>`).
4. In the tunnel's **Public Hostname** tab add TWO hostnames, both pointing
   at the same origin:

   | Public hostname              | Service                        | Used by                              |
   |------------------------------|--------------------------------|--------------------------------------|
   | `api.yourdomain.ie`          | `http://<unraid-lan-ip>:8000`  | mobile app + web dashboard (supabase-js `createClient` URL) |
   | `studio.yourdomain.ie`       | `http://<unraid-lan-ip>:8000`  | you, in a browser (Studio admin)     |

   WebSockets (Realtime) work through cloudflared out of the box.
5. Update `.env` and restart:

   ```sh
   SUPABASE_PUBLIC_URL=https://studio.yourdomain.ie
   API_EXTERNAL_URL=https://api.yourdomain.ie/auth/v1
   SITE_URL=https://<wherever-the-web-dashboard-is-hosted>
   ```

   ```sh
   docker compose up -d
   ```

6. Strongly recommended: in Zero Trust ➜ Access, put an Access policy
   (email OTP / SSO) in front of `studio.yourdomain.ie`. Kong's basic auth
   then becomes the second lock, not the only one.

Client config: `createClient('https://api.yourdomain.ie', ANON_KEY)` in both
the React Native app and the web dashboard.

## 9. Backups

Nightly logical dump via the **User Scripts** plugin (schedule: custom,
`30 2 * * *`):

```sh
#!/bin/bash
set -e
BACKUP_DIR=/mnt/user/backups/timetable
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F)
docker exec supabase-db pg_dump -U postgres -d postgres -Fc \
  > "$BACKUP_DIR/timetable-$STAMP.dump"
# keep 14 days locally
find "$BACKUP_DIR" -name 'timetable-*.dump' -mtime +14 -delete
```

Notes:

* `pg_dump -Fc` (custom format) restores with
  `pg_restore -U postgres -d postgres --clean --if-exists`. Restore into a
  freshly booted stack **after** running `apply-migrations.sh` is the
  cleanest disaster-recovery path.
* Send a copy off-site — e.g. `rclone copy $BACKUP_DIR remote:timetable-backups`
  appended to the same script (rclone is available as an Unraid plugin).
  Location pings are personal data under GDPR: encrypt the remote
  (`rclone crypt`) and apply the same 90-day thinking to old dumps —
  a dump outlives the database's own retention purge.
* Back up `.env` (once, somewhere safe like a password manager) — losing
  `JWT_SECRET`/`POSTGRES_PASSWORD` makes the data folder unrecoverable-ish.
* Do NOT file-copy `${DATA_DIR}/db/data` while Postgres is running; use
  pg_dump as above (or stop the stack first for a cold copy).
* The Unraid "Appdata Backup" plugin: exclude `timetable/db/data` or stop
  the stack for the duration — live-copying pgdata produces corrupt backups.

## 10. Going to production SMS (Twilio Verify)

The dev stack sends no SMS: `SMS_TEST_OTP` maps `353870000000` ➜ `123456`
and GoTrue skips the provider entirely for that number. For real workers:

1. Create a Twilio account ➜ **Verify** ➜ create a Verify Service. Note the
   Account SID, Auth Token, and Verify Service SID (`VA...`).
2. In `.env`:

   ```sh
   SMS_PROVIDER=twilio_verify
   SMS_TWILIO_VERIFY_ACCOUNT_SID=AC...
   SMS_TWILIO_VERIFY_AUTH_TOKEN=...
   SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID=VA...
   SMS_TEST_OTP=            # remove the dev backdoor!
   ```

3. In `docker-compose.yml` (auth service) uncomment the three
   `GOTRUE_SMS_TWILIO_VERIFY_*` lines.
4. `docker compose up -d auth`
5. Test with your own phone before rolling out. Irish mobile numbers must be
   E.164: `+3538xxxxxxxx`.

Twilio Verify handles OTP generation/checking on Twilio's side, so
`SMS_OTP_LENGTH`/`SMS_OTP_EXP` are governed by the Verify service settings.

You can keep a `SMS_TEST_OTP` entry alongside a real provider temporarily
(e.g. for app-store review accounts) — matching numbers use the fixed code,
everyone else gets a real SMS. Remove it when you don't need it.

## 11. Day-2 operations

* **Logs:** `docker compose logs -f auth` (or any service name).
* **Upgrades:** edit the image tags to the ones in the current official
  `docker/docker-compose.yml` of `supabase/supabase`, then
  `docker compose pull && docker compose up -d`. Check upstream for changes
  to `volumes/db/*.sql` / `kong.yml` / `kong-entrypoint.sh` when you do.
* **New migrations:** drop `0007_*.sql` into `../migrations` and re-run
  `sh apply-migrations.sh` — already-applied files are skipped.
* **Full reset (DESTROYS ALL DATA):**
  `docker compose down && rm -rf /mnt/user/appdata/timetable/db/data`
  then start again from step 4.
