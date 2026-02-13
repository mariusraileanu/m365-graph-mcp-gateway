#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${1:-openclaw}"
PROFILE_DIR="${2:-/home/node/.openclaw/browser/openclaw/user-data}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found; skipping browser profile lock cleanup."
  exit 0
fi

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "Container ${CONTAINER_NAME} is not running; skipping browser profile lock cleanup."
  exit 0
fi

docker exec "${CONTAINER_NAME}" sh -lc "
  if [ -d '${PROFILE_DIR}' ]; then
    rm -f '${PROFILE_DIR}/SingletonCookie' '${PROFILE_DIR}/SingletonLock' '${PROFILE_DIR}/SingletonSocket'
    echo 'Cleared stale Chromium Singleton* locks in ${PROFILE_DIR}'
  else
    echo 'Browser profile directory not found, skipping: ${PROFILE_DIR}'
  fi
"
