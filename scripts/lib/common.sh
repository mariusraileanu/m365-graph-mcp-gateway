#!/usr/bin/env bash
set -euo pipefail

repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  (cd "$script_dir/.." && pwd)
}

ensure_dir_secure() {
  local d="$1"
  mkdir -p "$d"
  chmod 700 "$d" || true
}

ensure_file_secure() {
  local f="$1"
  chmod 600 "$f" || true
}

container_running() {
  local name="$1"
  docker ps --format '{{.Names}}' | grep -qx "$name"
}
