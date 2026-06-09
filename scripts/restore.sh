#!/usr/bin/env bash
# Restore an Ember backup (from GET /api/backup or the Settings "Download full
# backup" button) into a FRESH stack. The archive is a tar.gz containing:
#   db.sql                      — a pg_dump of the whole app DB (restores clean:
#                                 dumped with --clean --if-exists --no-owner)
#   pdfs/<account>/<file>.pdf   — every stored bill PDF
#   MANIFEST.txt                — created-at, version, counts, the secret-key notice
#
# IMPORTANT — NGRID_SECRET_KEY is NOT in the archive (by design). The DB only holds
# AES-GCM *ciphertext* for your National Grid logins; the key that decrypts them is
# the NGRID_SECRET_KEY env var (or the auto-generated session/secret.key). Set the
# SAME key in the new stack's .env (from your separate secret backup) BEFORE you use
# the restored logins, or they won't decrypt. Your charts/bills/usage restore fine
# regardless — only the saved NG-login credentials need the key.
#
# Usage:
#   ./scripts/restore.sh <backup.tar.gz> [--db-container <name>] [--pdf-dir <path>]
#
# Defaults match the standalone docker-compose.yml:
#   --db-container ngrid_postgres   (Postgres service; user/db both "ngrid")
#   --pdf-dir      ./data/pdfs      (the host PDF_DIR mount)
#
# Run this from the repo root (where docker-compose.yml lives), with the stack's
# Postgres already up and EMPTY:  docker compose up -d ngrid_postgres
#
# Direct-psql alternative (no docker compose — e.g. an external Postgres): replace
# the `docker compose exec -T "$DB_CONTAINER" psql ...` line below with:
#   psql "$DATABASE_URL" < "$tmp/db.sql"
set -euo pipefail

DB_CONTAINER="ngrid_postgres"
DB_USER="ngrid"
DB_NAME="ngrid"
PDF_DIR="./data/pdfs"
ARCHIVE=""

usage() {
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --db-container) DB_CONTAINER="${2:?--db-container needs a value}"; shift 2 ;;
    --pdf-dir) PDF_DIR="${2:?--pdf-dir needs a value}"; shift 2 ;;
    --*) echo "error: unknown option '$1'" >&2; usage 1 ;;
    *)
      if [ -n "$ARCHIVE" ]; then echo "error: only one backup archive may be given" >&2; usage 1; fi
      ARCHIVE="$1"; shift ;;
  esac
done

if [ -z "$ARCHIVE" ]; then echo "error: no backup archive given" >&2; usage 1; fi
if [ ! -f "$ARCHIVE" ]; then echo "error: backup archive not found: $ARCHIVE" >&2; exit 1; fi

# Temp workspace, cleaned up on any exit.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[restore] extracting $ARCHIVE ..."
tar -xzf "$ARCHIVE" -C "$tmp"

if [ ! -f "$tmp/db.sql" ]; then
  echo "error: $ARCHIVE has no db.sql — is this an Ember full backup?" >&2
  exit 1
fi
[ -f "$tmp/MANIFEST.txt" ] && { echo "[restore] manifest:"; sed 's/^/    /' "$tmp/MANIFEST.txt"; }

echo "[restore] loading db.sql into $DB_CONTAINER (db=$DB_NAME, user=$DB_USER) ..."
# The dump was taken with --clean --if-exists, so it drops + recreates objects and
# restores cleanly into an empty (or re-restored) DB regardless of role.
docker compose exec -T "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$tmp/db.sql"

if [ -d "$tmp/pdfs" ]; then
  echo "[restore] copying bill PDFs into $PDF_DIR ..."
  mkdir -p "$PDF_DIR"
  # Copy the *contents* of pdfs/ (the per-account subdirs) into PDF_DIR.
  cp -a "$tmp/pdfs/." "$PDF_DIR/"
else
  echo "[restore] no pdfs/ in the archive — skipping PDF copy"
fi

echo "[restore] sanity check — row counts:"
docker compose exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
  -tAc 'select '\''Bill='\''||count(*) from "Bill"' 2>/dev/null || echo "    (could not count Bill)"
docker compose exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
  -tAc 'select '\''Usage='\''||count(*) from "Usage"' 2>/dev/null || echo "    (could not count Usage)"

echo "[restore] done."
echo "[restore] REMINDER: set NGRID_SECRET_KEY in this stack's .env (from your separate"
echo "[restore]           secret backup) so the restored NG-logins decrypt — the DB only"
echo "[restore]           holds ciphertext. Then start the app: docker compose up -d"
