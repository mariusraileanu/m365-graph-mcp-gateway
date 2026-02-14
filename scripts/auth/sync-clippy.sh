#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=../lib/common.sh
source "${ROOT_DIR}/scripts/lib/common.sh"

CONTAINER_NAME="${1:-openclaw}"
HOST_CLIPPY_DIR="${2:-}"
DEST_CLIPPY_DIR="${3:-./data/clippy}"
CONTAINER_CLIPPY_DIR="/home/node/.config/clippy"

if [[ -z "${HOST_CLIPPY_DIR}" ]]; then
  if [[ -n "${CLIPPY_HOST_PROFILE_DIR:-}" ]]; then
    HOST_CLIPPY_DIR="${CLIPPY_HOST_PROFILE_DIR}"
  elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    HOST_CLIPPY_DIR="${XDG_CONFIG_HOME}/clippy"
  else
    HOST_CLIPPY_DIR="${HOME}/.config/clippy"
  fi
fi

required_files=(
  "config.json"
  "token-cache.json"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "${HOST_CLIPPY_DIR}/${file}" ]]; then
    echo "Error: missing file '${HOST_CLIPPY_DIR}/${file}'." >&2
    exit 1
  fi
done

ensure_dir_secure "${DEST_CLIPPY_DIR}"
if [[ "$(cd "${HOST_CLIPPY_DIR}" && pwd)" != "$(cd "${DEST_CLIPPY_DIR}" && pwd)" ]]; then
  cp "${HOST_CLIPPY_DIR}/config.json" "${DEST_CLIPPY_DIR}/config.json"
  cp "${HOST_CLIPPY_DIR}/token-cache.json" "${DEST_CLIPPY_DIR}/token-cache.json"
fi
# Self-heal edge case: if destination files are missing, try one more copy from source.
for file in "config.json" "token-cache.json"; do
  if [[ ! -f "${DEST_CLIPPY_DIR}/${file}" && -f "${HOST_CLIPPY_DIR}/${file}" ]]; then
    cp "${HOST_CLIPPY_DIR}/${file}" "${DEST_CLIPPY_DIR}/${file}"
  fi
done
for file in "config.json" "token-cache.json"; do
  if [[ ! -r "${DEST_CLIPPY_DIR}/${file}" ]]; then
    echo "Error: destination file missing/unreadable '${DEST_CLIPPY_DIR}/${file}'." >&2
    exit 1
  fi
done
ensure_file_secure "${DEST_CLIPPY_DIR}/config.json"
ensure_file_secure "${DEST_CLIPPY_DIR}/token-cache.json"

# Optional but important for long-lived automation:
# Clippy can reuse saved browser session cookies from storage-state.json
# when token refresh is no longer valid.
if [[ -f "${HOST_CLIPPY_DIR}/storage-state.json" ]]; then
  if [[ "$(cd "${HOST_CLIPPY_DIR}" && pwd)" != "$(cd "${DEST_CLIPPY_DIR}" && pwd)" ]]; then
    cp "${HOST_CLIPPY_DIR}/storage-state.json" "${DEST_CLIPPY_DIR}/storage-state.json"
  fi
  ensure_file_secure "${DEST_CLIPPY_DIR}/storage-state.json"
  echo "Synced optional browser session file: ${DEST_CLIPPY_DIR}/storage-state.json"
else
  echo "Warning: ${HOST_CLIPPY_DIR}/storage-state.json not found."
  echo "Clippy may require 'clippy login --interactive' when refresh tokens expire."
fi
echo "Synced Clippy auth files to host mount: ${DEST_CLIPPY_DIR}"

if command -v docker >/dev/null 2>&1 && container_running "${CONTAINER_NAME}"; then
  docker exec "${CONTAINER_NAME}" sh -lc "mkdir -p '${CONTAINER_CLIPPY_DIR}' && chmod 700 '${CONTAINER_CLIPPY_DIR}'"
  docker exec "${CONTAINER_NAME}" sh -lc "rm -f '${CONTAINER_CLIPPY_DIR}/config.json' '${CONTAINER_CLIPPY_DIR}/token-cache.json' '${CONTAINER_CLIPPY_DIR}/storage-state.json'"
  cat "${DEST_CLIPPY_DIR}/config.json" | docker exec -i "${CONTAINER_NAME}" sh -lc "umask 077; cat > '${CONTAINER_CLIPPY_DIR}/config.json'"
  cat "${DEST_CLIPPY_DIR}/token-cache.json" | docker exec -i "${CONTAINER_NAME}" sh -lc "umask 077; cat > '${CONTAINER_CLIPPY_DIR}/token-cache.json'"
  if [[ -f "${DEST_CLIPPY_DIR}/storage-state.json" ]]; then
    cat "${DEST_CLIPPY_DIR}/storage-state.json" | docker exec -i "${CONTAINER_NAME}" sh -lc "umask 077; cat > '${CONTAINER_CLIPPY_DIR}/storage-state.json'"
  fi
  echo "Synced Clippy auth files to running container: ${CONTAINER_NAME}:${CONTAINER_CLIPPY_DIR}"
fi

echo "Next check: docker exec ${CONTAINER_NAME} clippy whoami"
