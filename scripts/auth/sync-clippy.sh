#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat <<'EOF'
Sync Clippy auth files.

Usage:
  sync-clippy.sh                     # Local: data/clippy -> container
  sync-clippy.sh --host <vm-ip>     # Remote: laptop -> VM -> container

Options:
  --host <ip>      Remote VM IP (enables SSH-based sync)
  --user <name>   SSH user (default: azureuser)
  --source <dir>  Source directory (default: ~/.config/clippy)
  --dest <dir>    Destination directory (default: ./data/clippy)

Required source files:
  - config.json
  - token-cache.json

Optional source files:
  - storage-state.json
EOF
}

HOST=""
USER_NAME="azureuser"
SOURCE_DIR="${HOME}/.config/clippy"
DEST_DIR="${ROOT_DIR}/data/clippy"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --source) SOURCE_DIR="${2:-}"; shift 2 ;;
    --dest) DEST_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage >&2; exit 2 ;;
  esac
done

check_source_files() {
  local dir="$1"
  for f in config.json token-cache.json; do
    if [[ ! -f "${dir}/${f}" ]]; then
      echo "Error: missing ${dir}/${f}" >&2
      exit 1
    fi
    if [[ ! -s "${dir}/${f}" ]]; then
      echo "Error: empty ${dir}/${f}" >&2
      exit 1
    fi
  done
}

sync_local() {
  check_source_files "$SOURCE_DIR"

  mkdir -p "$DEST_DIR"
  cp "${SOURCE_DIR}/config.json" "${DEST_DIR}/"
  cp "${SOURCE_DIR}/token-cache.json" "${DEST_DIR}/"

  if [[ -f "${SOURCE_DIR}/storage-state.json" ]]; then
    cp "${SOURCE_DIR}/storage-state.json" "${DEST_DIR}/"
    echo "Synced storage-state.json"
  fi

  chmod 600 "${DEST_DIR}"/*.json 2>/dev/null || true
  echo "Synced Clippy auth to: ${DEST_DIR}"

  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "openclaw"; then
    docker exec openclaw sh -lc "mkdir -p '/home/node/.config/clippy' && chmod 700 '/home/node/.config/clippy'"
    echo "Synced to container"
  fi
}

sync_remote() {
  if [[ -z "$HOST" ]]; then
    echo "Error: --host required for remote sync" >&2
    exit 1
  fi

  check_source_files "$SOURCE_DIR"

  local remote="${USER_NAME}@${HOST}"
  local remote_dir="${ROOT_DIR}/data/clippy"

  echo "[1/3] Creating remote directory..."
  ssh -o StrictHostKeyChecking=accept-new "$remote" "mkdir -p '${remote_dir}'"

  echo "[2/3] Copying files..."
  scp -q "${SOURCE_DIR}/config.json" "${remote}:${remote_dir}/"
  scp -q "${SOURCE_DIR}/token-cache.json" "${remote}:${remote_dir}/"

  if [[ -f "${SOURCE_DIR}/storage-state.json" ]]; then
    scp -q "${SOURCE_DIR}/storage-state.json" "${remote}:${remote_dir}/"
  fi

  echo "[3/3] Securing files..."
  ssh -o StrictHostKeyChecking=accept-new "$remote" "chmod 600 '${remote_dir}'/*.json 2>/dev/null || true"

  echo "Done. Verify with: ssh ${remote} 'docker exec openclaw clippy whoami'"
}

if [[ -n "$HOST" ]]; then
  sync_remote
else
  sync_local
fi
