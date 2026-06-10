#!/usr/bin/env bash
# Apply DB schema, start a background scheduler loop, then run Next.js.
set -e

# Arbitrary-uid tolerance (OpenShift-style). The image defaults to the `ember`
# user, but the operator overrides it (`user: "1003:1004"`) to match the host so
# the backup user can read the session files. An overridden uid has no /etc/passwd
# entry, so getpwuid() fails — and psql/pg_dump and chromium both abort with
# "local user with ID … does not exist". If the current uid is unknown and
# /etc/passwd is writable (made group-0-writable in the Dockerfile), self-register
# it so the rest of the entrypoint and the scraper run cleanly.
if ! whoami >/dev/null 2>&1; then
  if [ -w /etc/passwd ]; then
    echo "ember:x:$(id -u):$(id -g):ember:${HOME:-/tmp}:/sbin/nologin" >> /etc/passwd
  fi
fi

# Drop Prisma-only query parameters from a postgres:// URL so it's a valid libpq
# conninfo. libpq rejects ANY query parameter it doesn't recognize (psql/pg_dump exit
# with `invalid URI query parameter: "..."`), but Prisma routinely appends its own —
# e.g. ?schema=public (our .env.example default + the smoke-boot CI URL),
# connection_limit, pool_timeout, pgbouncer, socket_timeout, statement_cache_size,
# sslidentity. We strip those, keeping libpq-valid params (sslmode, connect_timeout,
# sslcert, …) so external/TLS Postgres still connects. Echoes the cleaned URL.
strip_prisma_url_params() {
  local url="$1"
  local base="${url%%\?*}"          # everything before the query string
  if [ "$base" = "$url" ]; then     # no query string at all
    printf '%s' "$url"
    return 0
  fi
  local query="${url#*\?}"
  local kept="" IFS='&'
  local pair
  for pair in $query; do
    case "${pair%%=*}" in
      schema|connection_limit|pool_timeout|pgbouncer|socket_timeout|statement_cache_size|sslidentity)
        ;;  # Prisma-only — drop it
      "") ;;  # empty fragment (e.g. trailing &) — drop it
      *) kept="${kept:+$kept&}$pair" ;;
    esac
  done
  printf '%s' "${base}${kept:+?$kept}"
}

# ── Pre-migrate backup ──────────────────────────────────────────────────────
# The schema is applied with `prisma db push --accept-data-loss` and there is no
# rollback, so a schema change could in principle drop data. Before applying it,
# if the live database already holds data AND its schema differs from the target,
# dump it to $BACKUP_DIR (a host-mounted volume) so there is always a restore
# point. Fail-closed: if the backup can't be written, we refuse to touch the
# schema. Disable with BACKUP_BEFORE_MIGRATE=false.
backup_before_migrate() {
  if [ "${BACKUP_BEFORE_MIGRATE:-true}" != "true" ]; then
    echo "[entrypoint] pre-migrate backup disabled (BACKUP_BEFORE_MIGRATE=false)"
    return 0
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "[entrypoint] WARNING: pg_dump not found — skipping pre-migrate backup"
    return 0
  fi

  # Two connection modes for the psql probe / pg_dump, chosen by whether DB_PASSWORD
  # is set:
  #
  #   DB_PASSWORD set  → discrete libpq params (-h/-p/-U/-d) + PGPASSWORD=$DB_PASSWORD.
  #     libpq parses URLs strictly, so a password containing %, @, #, $ (all valid via
  #     env_file) makes psql/pg_dump fail to parse a URL even though Prisma's looser
  #     parser accepts it (issue #83). Taking the password RAW from $DB_PASSWORD (no
  #     parsing) and the host/port from the URL authority sidesteps that. Host/port are
  #     the slice after the LAST '@' and before the first '/', neither of which can
  #     contain the password's special characters.
  #     Known limitation: an IPv6 host literal (e.g. [::1]:5432) would mis-parse in the
  #     host:port split below — not supported in this mode (use DB_PASSWORD + a hostname,
  #     or leave DB_PASSWORD unset to use the URL conninfo path which handles it).
  #
  #   DB_PASSWORD unset → use $DATABASE_URL as a single libpq conninfo, with NO PGPASSWORD.
  #     When DB_PASSWORD is empty the URL is the only credential source, and a URL-only
  #     config is perfectly valid (Prisma handles it); libpq decodes the percent-encoded
  #     password from the URL fine. (The discrete-param raw-password trick above is
  #     irrelevant here — there's no raw password to feed it.) Caveat: libpq REJECTS any
  #     query parameter it doesn't recognize, including the Prisma-only ones Prisma puts in
  #     DATABASE_URL (e.g. ?schema=public — the default in our .env.example, also set by
  #     the smoke-boot CI job). We strip those before handing the URL to libpq, leaving
  #     libpq-valid params (sslmode, connect_timeout, …) intact so external/TLS DBs work.
  local -a pg_conn
  local pghost pgport pguser pgdb
  if [ -n "${DB_PASSWORD:-}" ]; then
    local authority="${DATABASE_URL##*@}"   # host:port/db?params  (password stripped)
    authority="${authority%%/*}"            # host:port
    pghost="${authority%%:*}"
    pgport="${authority##*:}"
    [ "$pgport" = "$authority" ] && pgport=5432   # no explicit port in the URL
    pguser="${DB_USER:-ngrid}"
    pgdb="${DB_NAME:-ngrid}"
    pg_conn=(-h "$pghost" -p "$pgport" -U "$pguser" -d "$pgdb")
    export PGPASSWORD="$DB_PASSWORD"
  else
    pg_conn=("$(strip_prisma_url_params "$DATABASE_URL")")   # URL conninfo; libpq decodes the encoded password
    unset PGPASSWORD
  fi

  # Probe for an app table to tell a fresh DB from a populated one. Distinguish the
  # probe's EXIT CODE from its output so a connect/auth/db-missing failure is NOT
  # mistaken for "fresh" (that would silently skip the only pre-migrate safety net):
  #   rc != 0           → AMBIGUOUS (could not connect) → fail closed.
  #   rc == 0, empty    → connected, table absent → genuinely fresh, skip backup.
  #   rc == 0, "1"      → table exists → fall through to the schema-diff/backup logic.
  # The discriminator is $rc, not stderr. `set -e` would abort on the failing probe
  # (a plain assignment whose command substitution fails does trip errexit), so turn
  # it off just around the probe and capture the real exit code into $rc.
  # PGPASSWORD is already exported (DB_PASSWORD set) or unset (URL conninfo carries
  # the credential) by the branch above — the call below is identical in both modes.
  local has_account rc
  set +e
  has_account="$(psql "${pg_conn[@]}" -Atqc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='Account' LIMIT 1" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "[entrypoint] ERROR: could not probe the database to decide on a pre-migrate backup."
    if [ -n "${DB_PASSWORD:-}" ]; then
      echo "[entrypoint] psql exited $rc connecting as user='$pguser' db='$pgdb' to $pghost:$pgport:"
    else
      echo "[entrypoint] psql exited $rc connecting via DATABASE_URL:"
    fi
    echo "[entrypoint]   $has_account"
    echo "[entrypoint] If DATABASE_URL points at an EXTERNAL Postgres with a special-char password,"
    echo "[entrypoint] set DB_USER/DB_NAME/DB_PASSWORD (raw password) so the backup uses discrete"
    echo "[entrypoint] libpq params instead of the URL. Otherwise the connection is misconfigured."
    echo "[entrypoint] Refusing to apply schema changes without a verified backup."
    echo "[entrypoint] Set BACKUP_BEFORE_MIGRATE=false to override (NOT recommended)."
    exit 1
  fi
  if [ "$has_account" != "1" ]; then
    echo "[entrypoint] fresh database — no pre-migrate backup needed"
    return 0
  fi

  # Only back up when an upgrade will actually change the schema. `migrate diff`
  # exits 0 when the live DB already matches the target schema, non-zero otherwise.
  if npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code >/dev/null 2>&1; then
    echo "[entrypoint] database schema already in sync — no pre-migrate backup needed"
    return 0
  fi

  local dir="${BACKUP_DIR:-/data/backups}"
  mkdir -p "$dir"
  local out="$dir/ngrid-pre-migrate-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  echo "[entrypoint] schema change detected — backing up database to $out"
  # pipefail so a pg_dump failure fails the pipeline (gzip alone would still
  # succeed on empty input and mask it — that would defeat the safety net).
  if ! ( set -o pipefail; pg_dump "${pg_conn[@]}" | gzip > "$out" ); then
    rm -f "$out"
    echo "[entrypoint] ERROR: pre-migrate backup FAILED — refusing to apply schema changes."
    echo "[entrypoint] Fix the backup target, or set BACKUP_BEFORE_MIGRATE=false to override (NOT recommended)."
    exit 1
  fi

  # Retention: keep the newest BACKUP_RETENTION dumps (default 10).
  local keep="${BACKUP_RETENTION:-10}"
  ls -1t "$dir"/ngrid-pre-migrate-*.sql.gz 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f
  echo "[entrypoint] backup complete ($(du -h "$out" | cut -f1)); keeping newest $keep"
}

# Ops/test hook: run only the backup and exit (used by local/CI verification to
# exercise this exact code path without booting the app).
if [ "${1:-}" = "--pre-migrate-backup-only" ]; then
  backup_before_migrate
  exit $?
fi

echo "[entrypoint] syncing database schema..."
# Back up first (a no-op when the schema is unchanged or the DB is empty), then
# apply. db push is idempotent and needs no migration files, which keeps setup
# trivial for self-hosters. Additive changes apply cleanly.
backup_before_migrate
npx prisma db push --skip-generate --accept-data-loss

# Shared key so the internal cron endpoint can't be triggered externally.
export CRON_KEY="${CRON_KEY:-$(head -c24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c24)}"

# Background scheduler: first tick shortly after boot (initial population), then
# hourly. The tick endpoint itself decides whether a scrape is actually due.
(
  sleep 25
  while true; do
    curl -fsS -m 290 -X POST -H "x-cron-key: ${CRON_KEY}" http://127.0.0.1:3000/api/cron/tick \
      && echo "" || echo "[entrypoint] cron tick failed (will retry)"
    sleep 3600
  done
) &

echo "[entrypoint] starting Next.js on :3000"
exec npx next start -p 3000 -H 0.0.0.0
