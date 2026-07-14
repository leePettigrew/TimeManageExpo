#!/bin/sh
# apply-migrations.sh — apply ../migrations/*.sql to the running db container.
#
# Run ON THE UNRAID HOST, from this directory, AFTER the stack is healthy:
#
#   sh apply-migrations.sh                 # uses container "supabase-db"
#   sh apply-migrations.sh my-db-container # override container name
#
# Why post-boot instead of first-boot initdb?
#   * GoTrue (auth) runs its own schema migrations when the service first
#     starts — only then does auth.users have its final shape (e.g. the
#     "phone" column read by claim_invite()). initdb scripts run before any
#     service has started.
#   * pg_cron must be CREATEd before 0006_retention_cron.sql runs, or the
#     retention/auto-close jobs are silently skipped. This script creates it.
#   * initdb only runs on an empty data dir; this script works on any boot.
#
# Idempotent: applied files are recorded in _migrations.applied and skipped
# on re-run. Each file is applied in a single transaction.

set -eu

CONTAINER="${1:-supabase-db}"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
MIGRATIONS_DIR="$SCRIPT_DIR/../migrations"

# psql into the db container. Runs as the postgres role (superuser in the
# self-hosted image; matches what Studio uses and what Supabase cloud runs
# user migrations as).
psql_exec() {
    docker exec -i "$CONTAINER" psql -U postgres -d postgres \
        -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

[ -d "$MIGRATIONS_DIR" ] || {
    echo "ERROR: migrations directory not found: $MIGRATIONS_DIR" >&2
    exit 1
}

echo "==> Waiting for Postgres in container '$CONTAINER'..."
i=0
until docker exec "$CONTAINER" pg_isready -U postgres -h localhost >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && { echo "ERROR: Postgres not ready after 60s" >&2; exit 1; }
    sleep 2
done

# GoTrue adds the phone column to auth.users via its own migrations on its
# first start. 0004_rpcs.sql reads it at runtime — make sure auth has
# finished migrating before we install the app schema.
echo "==> Waiting for GoTrue (auth) migrations (auth.users.phone)..."
i=0
until [ "$(psql_exec -tAc "select count(*) from information_schema.columns where table_schema='auth' and table_name='users' and column_name='phone'")" = "1" ]; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && {
        echo "ERROR: auth.users.phone still missing after 120s." >&2
        echo "       Is the 'auth' service running? Check: docker logs supabase-auth" >&2
        exit 1
    }
    sleep 2
done

# pg_cron is preloaded in the supabase/postgres image but the extension is
# not created by default. Create it so 0006_retention_cron.sql schedules the
# retention/auto-close jobs. NOTE: only works in the database named by
# cron.database_name (default: postgres).
echo "==> Ensuring pg_cron extension exists..."
psql_exec -c "CREATE EXTENSION IF NOT EXISTS pg_cron;"

echo "==> Ensuring migration bookkeeping table exists..."
psql_exec <<'SQL'
create schema if not exists _migrations;
create table if not exists _migrations.applied (
    filename   text primary key,
    applied_at timestamptz not null default now()
);
SQL

# Shell glob expansion returns files sorted, giving 0001..0006 order.
applied=0
skipped=0
for f in "$MIGRATIONS_DIR"/*.sql; do
    [ -e "$f" ] || { echo "ERROR: no .sql files in $MIGRATIONS_DIR" >&2; exit 1; }
    base=$(basename "$f")
    if [ "$(psql_exec -tAc "select count(*) from _migrations.applied where filename='$base'")" = "1" ]; then
        echo "  = $base (already applied, skipping)"
        skipped=$((skipped + 1))
        continue
    fi
    echo "  + $base"
    # Migration + bookkeeping insert in ONE transaction: a failure leaves
    # nothing half-applied and nothing falsely recorded.
    {
        cat "$f"
        printf "\ninsert into _migrations.applied (filename) values ('%s');\n" "$base"
    } | psql_exec --single-transaction -f -
    applied=$((applied + 1))
done

echo "==> Done. Applied: $applied, skipped: $skipped."
echo "==> Scheduled cron jobs:"
psql_exec -c "select jobid, jobname, schedule, command from cron.job order by jobid;" || true
