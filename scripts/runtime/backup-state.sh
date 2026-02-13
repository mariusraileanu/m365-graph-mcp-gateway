#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${1:-./data/.openclaw/backups}"
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +"%Y%m%dT%H%M%SZ")"
archive="${BACKUP_DIR}/runtime-state-${stamp}.tar.gz"
latest="${BACKUP_DIR}/latest-runtime-state.tar.gz"

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

mkdir -p "$tmpdir/data/.openclaw/cron"
cp -f ./data/.openclaw/openclaw.json "$tmpdir/data/.openclaw/openclaw.json"
if [[ -f ./data/.openclaw/cron/jobs.json ]]; then
  cp -f ./data/.openclaw/cron/jobs.json "$tmpdir/data/.openclaw/cron/jobs.json"
fi
if [[ -f ./.env ]]; then
  cp -f ./.env "$tmpdir/.env"
fi
if [[ -f ./docker-compose.yml ]]; then
  cp -f ./docker-compose.yml "$tmpdir/docker-compose.yml"
fi

tar -C "$tmpdir" -czf "$archive" .
cp -f "$archive" "$latest"

echo "Created backup: $archive"
echo "Updated latest: $latest"
