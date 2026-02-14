#!/usr/bin/env bash
set -euo pipefail

if [[ -x /home/node/.openclaw/skills/whoop-central/scripts/whoop-central ]]; then
  exec /home/node/.openclaw/skills/whoop-central/scripts/whoop-central "$@"
fi

if [[ -x /home/node/.openclaw/skills/whoop-central/whoop-central ]]; then
  exec /home/node/.openclaw/skills/whoop-central/whoop-central "$@"
fi

echo "whoop-central executable not found in skill directory." >&2
exit 1
