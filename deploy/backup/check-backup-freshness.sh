#!/usr/bin/env bash
#
# The dead-man's switch for the nightly backup.
#
# A backup that stops running is the failure mode nobody notices: the timer is quiet, the
# disk is quiet, and the first news is the restore that has nothing to restore. This script
# is the thing a monitoring job, a cron mail or a health probe runs instead: it exits 0 only
# when a *verified* backup exists and is younger than BACKUP_MAX_AGE_HOURS.
#
# Run it from the same timer as the backup (a second OnCalendar with a two-hour delay), or
# from any external monitor that can run a command.
#
# Exit codes:
#   0  the newest backup is fresh and its checksum matches
#   1  no backup, a stale backup, or a checksum that does not match
#   2  usage or missing configuration
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/abhyas}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"

die() {
  local code="$1"
  shift
  printf '%s ERROR %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit "$code"
}

[[ "$BACKUP_MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || die 2 "BACKUP_MAX_AGE_HOURS must be a whole number"
command -v sha256sum >/dev/null 2>&1 || die 2 "sha256sum is not installed"

if [[ ! -d "$BACKUP_DIR" ]]; then
  printf 'FAIL the backup directory %s does not exist\n' "$BACKUP_DIR" >&2
  exit 1
fi

newest=""
newest_epoch=0

# Newest first by name: backup-YYYYmmddTHHMMSSZ sorts by timestamp.
while IFS= read -r path; do
  name="${path##*/}"
  [[ "$name" =~ ^backup-([0-9]{8}T[0-9]{6})Z\.dump\.age$ ]] || continue
  stamp="${BASH_REMATCH[1]}"
  iso="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
  epoch="$(date -u -d "$iso" +%s 2>/dev/null || printf '0')"
  if ((epoch > newest_epoch)); then
    newest_epoch=$epoch
    newest="$path"
  fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'backup-*.dump.age' -printf '%p\n' | sort -r)

if [[ -z "$newest" ]]; then
  printf 'FAIL no backup exists in %s\n' "$BACKUP_DIR" >&2
  exit 1
fi

# "Verified" means the sidecar checksum exists and matches. A dump whose checksum file is
# missing is not counted as good news: silently trusting it is how a corrupt backup becomes
# a compliant-looking one.
sidecar="${newest%
.dump.age}.sha256"
if [[ ! -f "$sidecar" ]]; then
  printf 'FAIL %s has no checksum file (%s)\n' "${newest##*/}" "${sidecar##*/}" >&2
  exit 1
fi
if ! (cd "$BACKUP_DIR" && sha256sum --check --quiet --status "$(basename "$sidecar")"); then
  printf 'FAIL %s does not match its checksum\n' "${newest##*/}" >&2
  exit 1
fi

now_epoch="$(date -u +%s)"
age_seconds=$((now_epoch - newest_epoch))
max_seconds=$((BACKUP_MAX_AGE_HOURS * 3600))

if ((age_seconds > max_seconds)); then
  printf 'FAIL the newest backup is %s, older than %s hours\n' "${newest##*/}" "$BACKUP_MAX_AGE_HOURS" >&2
  exit 1
fi

printf 'OK %s is %s hours old (limit %s)\n' "${newest##*/}" "$((age_seconds / 3600))" "$BACKUP_MAX_AGE_HOURS"
exit 0
