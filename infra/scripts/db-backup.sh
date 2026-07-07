#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 127
  fi
}

require_nonempty() {
  if [[ -z "${!1:-}" ]]; then
    echo "missing required environment variable: $1" >&2
    exit 2
  fi
}

require_uint() {
  if ! [[ "${!1:-}" =~ ^[0-9]+$ ]]; then
    echo "$1 must be a non-negative integer" >&2
    exit 2
  fi
}

require_command pg_dump
require_command age

BACKUP_DATABASE_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/benzo-api}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_PREFIX="${BACKUP_PREFIX:-benzo-api}"

require_nonempty BACKUP_DATABASE_URL
require_nonempty BACKUP_AGE_RECIPIENT
require_uint BACKUP_KEEP

if [[ -z "${BACKUP_UPLOAD_CMD:-}" && "${BACKUP_SKIP_UPLOAD:-}" != "1" ]]; then
  echo "missing BACKUP_UPLOAD_CMD; set BACKUP_SKIP_UPLOAD=1 only for local dry-runs" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="${BACKUP_PREFIX}-${timestamp}.dump.age"
backup_tmp="$(mktemp "${BACKUP_DIR}/.${backup_name}.tmp.XXXXXX")"
backup_file="${BACKUP_DIR}/${backup_name}"

cleanup() {
  rm -f -- "$backup_tmp"
}
trap cleanup EXIT

pg_dump --format=custom --no-owner --no-acl --dbname="$BACKUP_DATABASE_URL" \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$backup_tmp"

mv "$backup_tmp" "$backup_file"
trap - EXIT

export BACKUP_FILE="$backup_file"
export BACKUP_NAME="$backup_name"
export BACKUP_DIR

if [[ "${BACKUP_SKIP_UPLOAD:-}" != "1" ]]; then
  bash -c "$BACKUP_UPLOAD_CMD"
fi

mapfile -t backups < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}-*.dump.age" | sort -r
)

if ((${#backups[@]} > BACKUP_KEEP)); then
  for old_backup in "${backups[@]:BACKUP_KEEP}"; do
    rm -f -- "$old_backup"
  done
fi

echo "created encrypted backup: $backup_file"
