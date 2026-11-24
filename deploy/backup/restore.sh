#!/usr/bin/env bash
#
# Restore an encrypted Abhyas backup into a scratch database, then prove the restore.
#
# This script is deliberately paranoid about its target. A restore is the one operation that
# can destroy the data it is meant to protect, so it prints the target before touching it and
# refuses the live database unless the operator says, in so many words, that they mean it.
#
# It never takes a password on the command line: every psql/createdb/pg_restore call runs
# inside the target container, where the credentials come from that container's environment.
#
# Exit codes:
#   0  restored and every verification item passed
#   2  usage or missing configuration
#   3  refused: that is the live database (or the override is missing)
#   4  the checksum does not match; nothing was touched
#   5  decryption, createdb or pg_restore failed
#   6  the restore happened but verification failed
#
set -euo pipefail

readonly PROGRAM="${0##*/}"

RESTORE_CONTAINER="${RESTORE_CONTAINER:-}"
RESTORE_DATABASE="${RESTORE_DATABASE:-}"
RESTORE_MANIFEST="${RESTORE_MANIFEST:-}"
RESTORE_BACKUP_KEY_FILE="${RESTORE_BACKUP_KEY_FILE:-${BACKUP_ENCRYPTION_KEY_FILE:-}}"
RESTORE_LIVE_CONTAINER="${RESTORE_LIVE_CONTAINER:-}"
RESTORE_COMPOSE_FILE="${RESTORE_COMPOSE_FILE:-}"
RESTORE_COMPOSE_ENV_FILE="${RESTORE_COMPOSE_ENV_FILE:-}"
RESTORE_SERVICE="${RESTORE_SERVICE:-postgres}"
RESTORE_OVERRIDE="${RESTORE_I_UNDERSTAND_THIS_REPLACES_DATA:-no}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  local code="$1"
  shift
  printf '%s ERROR %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit "$code"
}

usage() {
  cat >&2 <<'USAGE'
Usage: restore.sh <path/to/backup-YYYYmmddTHHMMSSZ.dump.age>

Restores into a scratch database and verifies it. The target is named by environment,
never by a command-line argument, so a password cannot leak into a process list.

  RESTORE_CONTAINER      the Postgres container to restore into (required)
  RESTORE_DATABASE       the database to create and restore into (required)
  RESTORE_MANIFEST       the manifest; defaults to the dump's .manifest.txt
  RESTORE_BACKUP_KEY_FILE  the age identity file (or BACKUP_ENCRYPTION_KEY_FILE)
  RESTORE_LIVE_CONTAINER   the production container, to refuse it by default

Refusing the live database: if the target container is RESTORE_LIVE_CONTAINER, or the
target database name equals the live container's POSTGRES_DB, the restore stops unless
RESTORE_I_UNDERSTAND_THIS_REPLACES_DATA=yes is set.
USAGE
}

[[ $# -eq 1 ]] || { usage; exit 2; }
DUMP="$1"
[[ -f "$DUMP" ]] || die 2 "no such dump: $DUMP"

command -v docker >/dev/null 2>&1 || die 2 "docker is not installed"
command -v sha256sum >/dev/null 2>&1 || die 2 "sha256sum is not installed"
command -v age >/dev/null 2>&1 || die 2 "age is not installed; apt install age"

[[ -n "$RESTORE_CONTAINER" ]] || die 2 "RESTORE_CONTAINER is required"
[[ -n "$RESTORE_DATABASE" ]] || die 2 "RESTORE_DATABASE is required"
[[ "$RESTORE_DATABASE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die 2 "RESTORE_DATABASE must be a plain lower-case name"

KEY_FILE="$RESTORE_BACKUP_KEY_FILE"
[[ -n "$KEY_FILE" ]] || die 2 "RESTORE_BACKUP_KEY_FILE (or BACKUP_ENCRYPTION_KEY_FILE) is required"
[[ -r "$KEY_FILE" ]] || die 4 "the key file is not readable"

stem="${DUMP%.dump.age}"
[[ "$stem" != "$DUMP" ]] || die 2 "the dump must end in .dump.age"
SIDECAR="${stem}.sha256"
[[ -f "$SIDECAR" ]] || die 4 "no checksum beside the dump: ${SIDECAR##*/}"

DEFAULT_MANIFEST="${stem}.manifest.txt"
MANIFEST="$RESTORE_MANIFEST"
[[ -n "$MANIFEST" ]] || MANIFEST="$DEFAULT_MANIFEST"
[[ -f "$MANIFEST" ]] || die 2 "no manifest at $MANIFEST"

SQL_FILE="$(dirname "$0")/verify-restore.sql"
[[ -f "$SQL_FILE" ]] || die 2 "verify-restore.sql is missing beside this script"

db_exec() {
  docker exec -T "$RESTORE_CONTAINER" "$@"
}

# ---------------------------------------------------------------------------
# The target, printed before anything happens
# ---------------------------------------------------------------------------

live_database=""
if [[ -n "$RESTORE_LIVE_CONTAINER" ]]; then
  live_database="$(docker exec -T "$RESTORE_LIVE_CONTAINER" printenv POSTGRES_DB 2>/dev/null || true)"
elif [[ -n "$RESTORE_COMPOSE_FILE" ]]; then
  live_id="$(docker compose -f "$RESTORE_COMPOSE_FILE" ${RESTORE_COMPOSE_ENV_FILE:+--env-file "$RESTORE_COMPOSE_ENV_FILE"} ps -q "$RESTORE_SERVICE" 2>/dev/null || true)"
  if [[ -n "$live_id" ]]; then
    live_database="$(docker exec -T "$live_id" printenv POSTGRES_DB 2>/dev/null || true)"
  fi
fi

log "target container: $RESTORE_CONTAINER"
log "target database:  $RESTORE_DATABASE"
log "dump:             ${DUMP##*/}"
log "manifest:         ${MANIFEST##*/}"

if [[ -n "$RESTORE_LIVE_CONTAINER" && "$RESTORE_CONTAINER" = "$RESTORE_LIVE_CONTAINER" ]]; then
  if [[ "$RESTORE_OVERRIDE" != "yes" ]]; then
    die 3 "that container is the live database; set RESTORE_I_UNDERSTAND_THIS_REPLACES_DATA=yes to restore over it"
  fi
fi

if [[ -n "$live_database" && "$RESTORE_DATABASE" = "$live_database" ]]; then
  if [[ "$RESTORE_OVERRIDE" != "yes" ]]; then
    die 3 "that database name is the live one ($live_database); set RESTORE_I_UNDERSTAND_THIS_REPLACES_DATA=yes to restore over it"
  fi
fi

# ---------------------------------------------------------------------------
# Checksum, before a single byte is decrypted
# ---------------------------------------------------------------------------

log "verifying the checksum"
if ! (cd "$(dirname "$DUMP")" && sha256sum --check --quiet --status "${SIDECAR##*/}"); then
  die 4 "the dump does not match ${SIDECAR##*/}; refusing to touch the target"
fi
log "checksum ok"

# ---------------------------------------------------------------------------
# Helpers to read the manifest
# ---------------------------------------------------------------------------

manifest_value() {
  awk -v key="$1" 'index($0, key ": ") == 1 { print substr($0, length(key) + 3); exit }' "$MANIFEST"
}

manifest_migrations_json() {
  awk '/^migration: / { value = substr($0, 12); gsub(/\\/, "\\\\", value); gsub(/"/, "\\\"", value)
                         printf "%s\"%s\"", (n++ ? "," : ""), value }
       END { printf "" }' "$MANIFEST" | sed 's/^/[/; s/$/]/'
}

manifest_tables_json() {
  awk '/^table: / {
         rest = substr($0, 8); split(rest, parts, " ")
         name = parts[1]; count = parts[2]
         if (name == "" || count == "") next
         printf "%s\"%s\":%s", (n++ ? "," : ""), name, count
       }
       END { printf "" }' "$MANIFEST" | sed 's/^/{/; s/$/}/'
}

EXPECTED_OWNER="$(manifest_value owner_role)"
EXPECTED_CONSTRAINTS="$(manifest_value constraint_count)"
EXPECTED_TABLES="$(manifest_tables_json)"
EXPECTED_MIGRATIONS="$(manifest_migrations_json)"

[[ -n "$EXPECTED_OWNER" ]] || die 2 "the manifest has no owner_role line"
[[ -n "$EXPECTED_CONSTRAINTS" ]] || die 2 "the manifest has no constraint_count line"
[[ "$EXPECTED_TABLES" != "{}" ]] || die 2 "the manifest has no table: lines"
[[ "$EXPECTED_MIGRATIONS" != "[]" ]] || die 2 "the manifest has no migration: lines"

# ---------------------------------------------------------------------------
# A fresh, empty database
# ---------------------------------------------------------------------------

exists="$(db_exec psql --no-psqlrc --no-password -q -A -t -d postgres \
  -c "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DATABASE'")"

if [[ -n "$exists" ]]; then
  owned="$(db_exec psql --no-psqlrc --no-password -q -A -t -d "$RESTORE_DATABASE" \
    -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')" 2>/dev/null || printf '0')"
  if [[ "$owned" != "0" && "$RESTORE_OVERRIDE" != "yes" ]]; then
    die 3 "$RESTORE_DATABASE exists with $owned tables; pick a fresh name or set RESTORE_I_UNDERSTAND_THIS_REPLACES_DATA=yes"
  fi
  log "dropping $RESTORE_DATABASE (a restore needs an empty database)"
  db_exec dropdb --if-exists --force "$RESTORE_DATABASE"
fi

log "creating $RESTORE_DATABASE owned by $EXPECTED_OWNER"
if ! db_exec createdb --owner="$EXPECTED_OWNER" "$RESTORE_DATABASE"; then
  die 5 "could not create $RESTORE_DATABASE; does the role $EXPECTED_OWNER exist in this container?"
fi

# ---------------------------------------------------------------------------
# Restore, one transaction, stop at the first error
# ---------------------------------------------------------------------------

log "restoring"
if ! age --decrypt --identity "$KEY_FILE" "$DUMP" \
  | db_exec pg_restore --exit-on-error --single-transaction --no-password --dbname="$RESTORE_DATABASE"; then
  die 5 "pg_restore failed; $RESTORE_DATABASE is incomplete"
fi
log "restored"

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

log "verifying (PASS/FAIL per item)"

set +e
verify_output="$(
  db_exec psql --no-psqlrc --no-password -X -q -A -t -F '|' -v ON_ERROR_STOP=1 \
    -v "expected_migrations=$EXPECTED_MIGRATIONS" \
    -v "expected_tables=$EXPECTED_TABLES" \
    -v "expected_owner=$EXPECTED_OWNER" \
    -v "expected_constraints=$EXPECTED_CONSTRAINTS" \
    -d "$RESTORE_DATABASE" -f - <"$SQL_FILE" 2>&1
)"
verify_status=$?
set -e

if ((verify_status != 0)); then
  printf '%s\n' "$verify_output" >&2
  die 6 "the verification script itself failed (psql exit $verify_status)"
fi

failures=0
while IFS='|' read -r status name detail; do
  [[ -z "$status" ]] && continue
  case "$status" in
    PASS)
      printf 'PASS %s: %s\n' "$name" "$detail"
      ;;
    SKIP)
      printf 'SKIP %s: %s\n' "$name" "$detail"
      ;;
    FAIL)
      printf 'FAIL %s: %s\n' "$name" "$detail"
      failures=$((failures + 1))
      ;;
    *)
      printf 'FAIL unparsed verification line: %s\n' "$*"
      failures=$((failures + 1))
      ;;
  esac
done <<<"$verify_output"

if ((failures > 0)); then
  printf 'RESTORE FAILED: %s verification item(s) did not pass in %s\n' "$failures" "$RESTORE_DATABASE" >&2
  exit 6
fi

printf 'RESTORE OK: %s restored from %s and every verification item passed\n' "$RESTORE_DATABASE" "${DUMP##*/}"
exit 0
