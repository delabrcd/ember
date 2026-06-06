#!/usr/bin/env bash
# Migration-safety check: prove that applying the CURRENT schema on top of a
# database created by the PREVIOUS release does not clobber existing data.
#
# The production entrypoint applies schema with `prisma db push --accept-data-loss`
# (no migration files; schema-as-source-of-truth) and there is NO rollback. So a
# change prisma considers destructive (drop column/table, narrowing type change)
# would SILENTLY delete production data on the next deploy.
#
# We mirror production exactly — seed representative rows into the old schema, then
# upgrade WITH --accept-data-loss — and then assert nothing was lost across three
# dimensions (running without the flag would false-positive on harmless additions
# like a new unique constraint, which prisma also tags "might be data loss"):
#   1. row counts per table are unchanged,
#   2. every column that existed before still exists (catches dropped columns/
#      tables, which row counts alone miss),
#   3. a fingerprint of business-critical values is unchanged (catches a narrowing
#      type change that corrupts values without changing counts/columns).
#
# Inputs (env): DATABASE_URL, OLD_SCHEMA, NEW_SCHEMA.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED="$HERE/seed.sql"
# Resolve to absolute paths: the prisma steps run from app/, so a repo-relative
# --schema (e.g. app/prisma/schema.prisma) would otherwise break under `cd app`.
OLD_SCHEMA="$(realpath "$OLD_SCHEMA")"
NEW_SCHEMA="$(realpath "$NEW_SCHEMA")"
TABLES=(Account Bill Usage Cost Weather AppSetting ScrapeRun ScheduleState)
printf -v TABLE_LIST "'%s'," "${TABLES[@]}"; TABLE_LIST="${TABLE_LIST%,}"   # 'Account','Bill',...

q() { psql "$DATABASE_URL" -Atqc "$1"; }

counts() { for t in "${TABLES[@]}"; do printf '%s=%s ' "$t" "$(q "SELECT count(*) FROM \"$t\";")"; done; }

# table.column inventory for the seeded tables (sorted, newline-separated).
columns() { q "SELECT table_name||'.'||column_name FROM information_schema.columns
               WHERE table_schema='public' AND table_name IN ($TABLE_LIST) ORDER BY 1;"; }

# Deterministic digest of business-critical seeded values. If any of these change
# or go null across the upgrade, the value was clobbered.
fingerprint() { q "
  SELECT md5(string_agg(v, '|' ORDER BY v)) FROM (
    SELECT 'acct:'||id||':'||\"accountNumber\"||':'||coalesce(\"serviceAddress\",'') v FROM \"Account\"
    UNION ALL SELECT 'bill:'||id||':'||coalesce(\"currentCharges\"::text,'')||':'||coalesce(\"totalDueAmount\"::text,'') FROM \"Bill\"
    UNION ALL SELECT 'cost:'||id||':'||\"fuelType\"||':'||kind||':'||amount FROM \"Cost\"
    UNION ALL SELECT 'use:'||id||':'||\"usageType\"||':'||quantity FROM \"Usage\"
    UNION ALL SELECT 'wx:'||id||':'||region||':'||\"avgTemperature\" FROM \"Weather\"
    UNION ALL SELECT 'set:'||key||':'||value FROM \"AppSetting\"
  ) t;"; }

echo "==> Reset database to a clean schema"
psql "$DATABASE_URL" -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

echo "==> Apply PREVIOUS release schema ($OLD_SCHEMA)"
( cd app && npx prisma db push --schema "$OLD_SCHEMA" --skip-generate --accept-data-loss >/dev/null )

echo "==> Seed representative data"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$SEED"
BEFORE_COUNTS="$(counts)"; BEFORE_COLS="$(columns)"; BEFORE_FP="$(fingerprint)"
echo "    counts: $BEFORE_COUNTS"
echo "    fingerprint: $BEFORE_FP"

echo "==> Upgrade to CURRENT schema WITH --accept-data-loss (exactly as the deploy entrypoint does)"
( cd app && npx prisma db push --schema "$NEW_SCHEMA" --skip-generate --accept-data-loss )

AFTER_COUNTS="$(counts)"; AFTER_COLS="$(columns)"; AFTER_FP="$(fingerprint)"
echo "    counts: $AFTER_COUNTS"
echo "    fingerprint: $AFTER_FP"

fail=0

if [ "$BEFORE_COUNTS" != "$AFTER_COUNTS" ]; then
  echo "::error::Row counts changed across the upgrade (rows were deleted)."
  echo "::error::before: $BEFORE_COUNTS"
  echo "::error::after:  $AFTER_COUNTS"
  fail=1
fi

# Every column present before must still be present (additions are fine).
MISSING="$(comm -23 <(printf '%s\n' "$BEFORE_COLS") <(printf '%s\n' "$AFTER_COLS"))"
if [ -n "$MISSING" ]; then
  echo "::error::Columns/tables that held data were dropped by the upgrade:"
  echo "$MISSING" | sed 's/^/::error::  - /'
  fail=1
fi

if [ "$BEFORE_FP" != "$AFTER_FP" ]; then
  echo "::error::Business-critical values changed across the upgrade (data corrupted/clobbered)."
  echo "::error::before fingerprint: $BEFORE_FP"
  echo "::error::after  fingerprint: $AFTER_FP"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "::error::Upgrade is NOT data-safe. Make the change additive, or add an explicit, reviewed data migration before merging."
  exit 1
fi

echo "==> OK: upgrade applied with --accept-data-loss and preserved every row, column, and critical value."
