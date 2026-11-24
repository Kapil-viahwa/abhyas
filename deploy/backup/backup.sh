#!/usr/bin/env bash
#
# A nightly logical backup of the Abhyas database, encrypted before it touches the disk.
#
# Design notes (the reasoning is in docs/deployment.md §12 and decision 0088):
#
#   * The dump runs *inside* the Postgres container, as the container's own role, so the
#     password comes from that container's environment. It is never an argument and never
#     appears in the host's process list.
#   * `pg_dump --format=custom` with ownership and privileges: the migration role owns the
#     tables and `test_questions` needs that ownership to be restored (the pinning migration
#     disables a trigger, which needs the owner). A `--no-owner` dump would restore into a
#     database where the triggers can be dropped but not re-created.
#   * Roles are NOT dumped. A `pg_dumpall --globals-only` file carries every role's password
#     hash, which is a secret of its own; the manifest records the role names and their
#     attributes instead, and docs/deployment.md §12 says how to create them before a restore.
#   * `age` encrypts: authenticated encryption (ChaCha20-Poly1305), an identity file, no
#     passphrase in argv, and one command to decrypt. `age` ships in Debian 12 and Ubuntu 24.04.
#   * Nothing is renamed into place until the checksum and `pg_restore --list` both pass, so a
#     failed run never leaves a half-written file that looks like a backup.
#
# Exit codes:
#   0  backup written, verified, optionally copied off-host, retention applied
#   2  usage or missing configuration
#   3  another backup is running (flock)
#   4  the encryption key is missing or too permissive
#   5  pg_dump failed
#   6  the written dump did not verify
#   7  the off-host hook failed
#   8  retention failed
#
set -euo pipefail

readonly PROGRAM="${0##*/}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/abhyas}"
BACKUP_ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
BACKUP_OFFSITE_HOOK="${BACKUP_OFFSITE_HOOK:-}"
BACKUP_COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-}"
BACKUP_COMPOSE_ENV_FILE="${BACKUP_COMPOSE_ENV_FILE:-}"
BACKUP_SERVICE="${BACKUP_SERVICE:-postgres}"
BACKUP_CONTAINER="${BACKUP_CONTAINER:-}"

DRY_RUN=0
PRUNE_ONLY=0

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
Usage: backup.sh [--dry-run] [--prune-only]

  --dry-run     do everything, but only print what retention would delete
  --prune-only  skip the dump; apply retention (with --dry-run, only report)

Environment:
  BACKUP_DIR                   where the files go (default /var/backups/abhyas)
  BACKUP_ENCRYPTION_KEY_FILE   an age identity file, mode 0600 — required
  BACKUP_KEEP_DAILY            daily copies to keep (default 7)
  BACKUP_KEEP_WEEKLY           weekly copies to keep (default 4)
  BACKUP_KEEP_MONTHLY          monthly copies to keep (default 6)
  BACKUP_OFFSITE_HOOK          an executable called with the encrypted file's path
  BACKUP_COMPOSE_FILE          use `docker compose -f FILE exec postgres` (prod)
  BACKUP_COMPOSE_ENV_FILE      optional --env-file for that compose call
  BACKUP_CONTAINER             or the name of a plain Postgres container (CI)

Set exactly one of BACKUP_COMPOSE_FILE and BACKUP_CONTAINER.
USAGE
}

while (($# > 0)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --prune-only) PRUNE_ONLY=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die 2 "unknown argument: $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || die 2 "docker is not installed"
command -v sha256sum >/dev/null 2>&1 || die 2 "sha256sum is not installed"
command -v flock >/dev/null 2>&1 || die 2 "flock is not installed (util-linux)"

if [[ -z "$BACKUP_COMPOSE_FILE" && -z "$BACKUP_CONTAINER" ]]; then
  die 2 "set BACKUP_COMPOSE_FILE (production) or BACKUP_CONTAINER (a named container)"
fi
if [[ -n "$BACKUP_COMPOSE_FILE" && -n "$BACKUP_CONTAINER" ]]; then
  die 2 "set only one of BACKUP_COMPOSE_FILE and BACKUP_CONTAINER"
fi

COMPOSE_ENV_ARGS=()
if [[ -n "$BACKUP_COMPOSE_ENV_FILE" ]]; then
  [[ -r "$BACKUP_COMPOSE_ENV_FILE" ]] || die 2 "BACKUP_COMPOSE_ENV_FILE is not readable"
  COMPOSE_ENV_ARGS=(--env-file "$BACKUP_COMPOSE_ENV_FILE")
fi

# The tool the whole scheme depends on: refuse early, with the fix in the message.
if ! command -v age >/dev/null 2>&1 || ! command -v age-keygen >/dev/null 2>&1; then
  die 2 "age and age-keygen are required; install them with: apt install age"
fi

KEY_FILE="$BACKUP_ENCRYPTION_KEY_FILE"
if [[ -z "$KEY_FILE" ]]; then
  die 4 "BACKUP_ENCRYPTION_KEY_FILE is not set"
fi
[[ -f "$KEY_FILE" ]] || die 4 "the encryption key file does not exist"
[[ -r "$KEY_FILE" ]] || die 4 "the encryption key file is not readable by this user"
key_mode="$(stat -c '%a' "$KEY_FILE")"
if (($((8#${key_mode})) & 8#077)); then
  die 4 "the encryption key file is readable by group or others (mode $key_mode); chmod 600 it"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# One backup at a time: a second nightly timer overlapping the first is a bug, not a queue.
exec 9>"$BACKUP_DIR/.backup.lock"
if ! flock -n 9; then
  die 3 "another backup holds the lock in $BACKUP_DIR"
fi

# ---------------------------------------------------------------------------
# Talking to the Postgres container
# ---------------------------------------------------------------------------

db_exec() {
  if [[ -n "$BACKUP_COMPOSE_FILE" ]]; then
    docker compose -f "$BACKUP_COMPOSE_FILE" "${COMPOSE_ENV_ARGS[@]}" exec -T "$BACKUP_SERVICE" "$@"
  else
    docker exec -T "$BACKUP_CONTAINER" "$@"
  fi
}

# Read a variable from the container's own environment — never from this shell, never printed.
container_env() {
  db_exec printenv "$1"
}

DATABASE="$(container_env POSTGRES_DB 2>/dev/null || true)"
[[ -n "$DATABASE" ]] || die 5 "the Postgres container does not expose POSTGRES_DB"

# psql that never prompts and never echoes: -q quiet, -A unaligned, -t tuples only.
db_psql() {
  db_exec psql --no-psqlrc --no-password -q -A -t -v ON_ERROR_STOP=1 -d "$DATABASE" "$@"
}

# ---------------------------------------------------------------------------
# The dump
# ---------------------------------------------------------------------------

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="backup-${stamp}"
final="$BACKUP_DIR/${base}.dump.age"
checksum_file="$BACKUP_DIR/${base}.sha256"
manifest_file="$BACKUP_DIR/${base}.manifest.txt"
tmp_dump="$BACKUP_DIR/.${base}.dump.age.partial"
tmp_manifest="$BACKUP_DIR/.${base}.manifest.txt.partial"

cleanup() {
  rm -f -- "$tmp_dump" "$tmp_manifest"
}
trap cleanup EXIT HUP INT TERM

if ((PRUNE_ONLY == 0)); then
  recipient="$(age-keygen -y "$KEY_FILE" 2>/dev/null)" || die 4 "the key file is not an age identity file"
  [[ -n "$recipient" ]] || die 4 "could not read a recipient from the key file"

  log "dumping $DATABASE from $([[ -n "$BACKUP_COMPOSE_FILE" ]] && printf 'compose:%s' "$BACKUP_SERVICE" || printf 'container:%s' "$BACKUP_CONTAINER")"

  umask 077

  # `exec` inside the container keeps the pipeline's exit status honest: with pipefail set,
  # a pg_dump failure fails this compound command rather than being hidden by age's success.
  if ! db_exec sh -c 'exec pg_dump --format=custom --compress=6 --no-password --dbname="$POSTGRES_DB"' \
    | age --encrypt --recipient "$recipient" --output "$tmp_dump"; then
    die 5 "pg_dump or age failed; nothing was written"
  fi

  [[ -s "$tmp_dump" ]] || die 5 "the encrypted dump is empty"

  # Verify before anything is given the real name: the dump must be readable by the tool
  # that would restore it, or it is not a backup.
  if ! age --decrypt --identity "$KEY_FILE" "$tmp_dump" \
    | db_exec pg_restore --list >/dev/null; then
    die 6 "the written dump does not list cleanly (pg_restore --list failed)"
  fi

  digest="$(sha256sum "$tmp_dump" | awk '{print $1}')"

  # The manifest: names, counts and versions only — no rows, no secrets.
  migrations="$(db_psql -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name")"
  roles="$(db_psql -F ' ' -c "SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname")"
  owner_role="$(db_psql -c "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.test_questions'::regclass")"
  constraints="$(db_psql -c "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND c.contype IN ('c','u','p','f')")"
  tables="$(db_psql -F ' ' -c "SELECT c.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname")"
  pg_dump_version="$(db_exec pg_dump --version)"
  age_version="$(age --version)"

  [[ -n "$owner_role" ]] || die 6 "could not read the owner of test_questions"

  git_commit="unknown"
  if command -v git >/dev/null 2>&1; then
    git_commit="$(git -C "$(dirname "$0")/../.." rev-parse HEAD 2>/dev/null || printf 'unknown')"
  fi

  postgres_image="unknown"
  if [[ -n "$BACKUP_COMPOSE_FILE" ]]; then
    postgres_image="$(docker compose -f "$BACKUP_COMPOSE_FILE" "${COMPOSE_ENV_ARGS[@]}" images --format '{{.Repository}}@{{.ID}}' "$BACKUP_SERVICE" 2>/dev/null | head -n1 || printf 'unknown')"
  else
    postgres_image="$(docker inspect --format '{{.Config.Image}}' "$BACKUP_CONTAINER" 2>/dev/null || printf 'unknown')"
  fi

  {
    printf 'abhyas backup manifest 1\n'
    printf 'backup: %s\n' "$base"
    printf 'timestamp: %s\n' "$stamp"
    printf 'database: %s\n' "$DATABASE"
    printf 'dump_sha256: %s\n' "$digest"
    printf 'encryption: age\n'
    printf 'git_commit: %s\n' "$git_commit"
    printf 'postgres_image: %s\n' "$postgres_image"
    printf 'pg_dump_version: %s\n' "$pg_dump_version"
    printf 'age_version: %s\n' "$age_version"
    printf 'owner_role: %s\n' "$owner_role"
    printf 'constraint_count: %s\n' "$constraints"
    printf '%s\n' "$roles" | while IFS= read -r line; do
      [[ -n "$line" ]] && printf 'role: %s\n' "$line"
    done
    printf '%s\n' "$migrations" | while IFS= read -r line; do
      [[ -n "$line" ]] && printf 'migration: %s\n' "$line"
    done
    printf '%s\n' "$tables" | while IFS= read -r line; do
      [[ -n "$line" ]] && printf 'table: %s\n' "$line"
    done
  } >"$tmp_manifest"

  mv -- "$tmp_dump" "$final"
  chmod 600 "$final"
  printf '%s  %s\n' "$digest" "${base}.dump.age" >"$checksum_file"
  chmod 600 "$checksum_file"
  mv -- "$tmp_manifest" "$manifest_file"
  chmod 600 "$manifest_file"

  log "wrote $(basename "$final") ($(wc -c <"$final") bytes, ${constraints} constraints, $(printf '%s\n' "$tables" | grep -c '^' || true) tables)"

  # Off-host: a hook, called with the encrypted file's path and nothing else. A failed copy
  # is a failed backup — a backup that only exists on the host that dies with the host is not
  # one — so it exits non-zero and the local files are kept for the next attempt to retry.
  if [[ -n "$BACKUP_OFFSITE_HOOK" ]]; then
    [[ -x "$BACKUP_OFFSITE_HOOK" ]] || die 7 "BACKUP_OFFSITE_HOOK is not executable"
    log "copying off-host with $BACKUP_OFFSITE_HOOK"
    if ! "$BACKUP_OFFSITE_HOOK" "$final"; then
      die 7 "the off-host hook failed; the local backup is kept at $final"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Retention: N newest days, M newest ISO weeks, K newest months
# ---------------------------------------------------------------------------

mapfile -t backups < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'backup-*.dump.age' -printf '%f\n' | sort -r)

declare -A keep=()
declare -A seen_day=()
declare -A seen_week=()
declare -A seen_month=()
days=0
weeks=0
months=0

for f in "${backups[@]}"; do
  ts="${f#backup-}"
  ts="${ts%%.dump.age}"
  [[ "$ts" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue

  day="${ts:0:8}"
  month="${ts:0:6}"
  iso="${ts:0:4}-${ts:4:2}-${ts:6:2}T${ts:9:2}:${ts:11:2}:${ts:13:2}Z"
  week="$(date -u -d "$iso" +%G-%V 2>/dev/null || printf 'unknown')"

  if [[ -z "${seen_day[$day]:-}" ]] && ((days < BACKUP_KEEP_DAILY)); then
    seen_day[$day]=1
    keep[$f]=1
    days=$((days + 1))
  fi
  if [[ -z "${seen_week[$week]:-}" ]] && ((weeks < BACKUP_KEEP_WEEKLY)); then
    seen_week[$week]=1
    keep[$f]=1
    weeks=$((weeks + 1))
  fi
  if [[ -z "${seen_month[$month]:-}" ]] && ((months < BACKUP_KEEP_MONTHLY)); then
    seen_month[$month]=1
    keep[$f]=1
    months=$((months + 1))
  fi
done

removed=0
for f in "${backups[@]}"; do
  [[ -n "${keep[$f]:-}" ]] && continue
  stem="${f%.dump.age}"
  if ((DRY_RUN == 1)); then
    log "would delete $f"
    removed=$((removed + 1))
    continue
  fi
  rm -f -- "$BACKUP_DIR/$f" "$BACKUP_DIR/${stem}.sha256" "$BACKUP_DIR/${stem}.manifest.txt" ||
    die 8 "could not delete $f"
  log "deleted $f"
  removed=$((removed + 1))
done

log "retention: kept ${#keep[@]} of ${#backups[@]}, $([[ $DRY_RUN -eq 1 ]] && printf 'would remove' || printf 'removed') $removed"

exit 0
