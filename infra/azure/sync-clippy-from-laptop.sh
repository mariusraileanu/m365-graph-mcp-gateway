#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Sync local Clippy auth files from laptop -> Azure VM -> running OpenClaw container.

Usage:
  infra/azure/sync-clippy-from-laptop.sh \
    --host <vm-ip-or-dns> \
    [--user azureuser] \
    [--source-dir ~/.config/clippy] \
    [--remote-repo /opt/openclaw-docker] \
    [--container openclaw]

Required local files:
  - config.json
  - token-cache.json

Optional local file:
  - storage-state.json
EOF
}

HOST=""
USER_NAME="azureuser"
SOURCE_DIR="${HOME}/.config/clippy"
REMOTE_REPO="/opt/openclaw-docker"
CONTAINER_NAME="openclaw"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
    --remote-repo) REMOTE_REPO="${2:-}"; shift 2 ;;
    --container) CONTAINER_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "Error: --host is required." >&2
  usage >&2
  exit 1
fi

for f in config.json token-cache.json; do
  if [[ ! -f "${SOURCE_DIR}/${f}" ]]; then
    echo "Error: missing local file: ${SOURCE_DIR}/${f}" >&2
    exit 1
  fi
done

REMOTE="${USER_NAME}@${HOST}"
REMOTE_DIR="${REMOTE_REPO}/data/clippy"

echo "[1/4] Creating remote target directory..."
ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "mkdir -p '${REMOTE_DIR}'"

echo "[2/4] Copying required Clippy files..."
scp -q "${SOURCE_DIR}/config.json" "$REMOTE:${REMOTE_DIR}/config.json"
scp -q "${SOURCE_DIR}/token-cache.json" "$REMOTE:${REMOTE_DIR}/token-cache.json"

if [[ -f "${SOURCE_DIR}/storage-state.json" ]]; then
  echo "[3/4] Copying optional storage-state.json..."
  scp -q "${SOURCE_DIR}/storage-state.json" "$REMOTE:${REMOTE_DIR}/storage-state.json"
else
  echo "[3/4] storage-state.json not found locally (optional). Skipping."
fi

echo "[4/4] Securing files and syncing into container..."
ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "bash -lc '
  set -euo pipefail
  test -f \"${REMOTE_DIR}/config.json\"
  test -f \"${REMOTE_DIR}/token-cache.json\"
  cd \"${REMOTE_REPO}\"
  chmod 600 \"${REMOTE_DIR}\"/*.json 2>/dev/null || true
  chown ${USER_NAME}:${USER_NAME} \"${REMOTE_DIR}\"/*.json 2>/dev/null || true
  bin/openclawctl auth-clippy \"${CONTAINER_NAME}\" \"${REMOTE_DIR}\" \"${REMOTE_DIR}\"
'"

echo "Done. Verify with:"
echo "  ssh ${REMOTE} 'docker exec ${CONTAINER_NAME} clippy whoami'"
