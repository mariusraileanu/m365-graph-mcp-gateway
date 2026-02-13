#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ARCHIVE_PATH="${1:-./data/.openclaw/backups/latest-runtime-state.tar.gz}"
CONTAINER_NAME="${2:-openclaw}"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "Backup archive not found: $ARCHIVE_PATH" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

tar -C "$tmpdir" -xzf "$ARCHIVE_PATH"

if [[ -f "$tmpdir/data/.openclaw/openclaw.json" ]]; then
  mkdir -p ./data/.openclaw
  cp -f "$tmpdir/data/.openclaw/openclaw.json" ./data/.openclaw/openclaw.json
  chmod 600 ./data/.openclaw/openclaw.json || true
fi

if [[ -f "$tmpdir/data/.openclaw/cron/jobs.json" ]]; then
  mkdir -p ./data/.openclaw/cron
  cp -f "$tmpdir/data/.openclaw/cron/jobs.json" ./data/.openclaw/cron/jobs.json
fi

if [[ -f "$tmpdir/.env" ]]; then
  cp -f "$tmpdir/.env" ./.env
  chmod 600 ./.env || true
fi

echo "Restored runtime state from: $ARCHIVE_PATH"
echo "Recreating container..."
docker compose up -d --force-recreate >/dev/null
docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_NAME" >/dev/null
echo "Restore complete."
