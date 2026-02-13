#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="${1:-openclaw}"

mkdir -p ./data/.openclaw ./data/clippy ./data/whoop

# Host-side mount permissions (best effort, ignores platform-specific chmod limits)
chmod 700 ./data/.openclaw || true
chmod 700 ./data/clippy || true
chmod 700 ./data/whoop || true
find ./data/.openclaw -type f -name '*.json' -exec chmod 600 {} \; 2>/dev/null || true
find ./data/clippy -type f -name '*.json' -exec chmod 600 {} \; 2>/dev/null || true
find ./data/whoop -type f -name '*.json' -exec chmod 600 {} \; 2>/dev/null || true

# Container-side state permissions
docker exec "$CONTAINER_NAME" sh -lc '
  chmod 700 /home/node/.openclaw || true
  chmod 700 /home/node/.config/clippy || true
  chmod 700 /home/node/.clawdbot/whoop || true
  find /home/node/.openclaw -type f -name "*.json" -exec chmod 600 {} \; 2>/dev/null || true
  find /home/node/.config/clippy -type f -name "*.json" -exec chmod 600 {} \; 2>/dev/null || true
  find /home/node/.clawdbot/whoop -type f -name "*.json" -exec chmod 600 {} \; 2>/dev/null || true
'

echo "State/auth permissions hardened on host and container."
