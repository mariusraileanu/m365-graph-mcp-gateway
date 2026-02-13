#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

err=0

need_cmd() {
  local c="$1"
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "Missing required command: $c" >&2
    err=1
  fi
}

need_cmd docker
need_cmd python3
need_cmd node

if ! docker compose version >/dev/null 2>&1; then
  echo "Missing Docker Compose v2 (docker compose ...)." >&2
  err=1
fi

if [[ ! -f ".env" ]]; then
  echo "Missing .env file in repo root." >&2
  err=1
fi

mkdir -p ./data/.openclaw ./data/workspace ./data/clippy ./data/whoop

if [[ "$err" -ne 0 ]]; then
  exit 1
fi

echo "Prerequisite validation passed."
