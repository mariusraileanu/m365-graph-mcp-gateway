#!/usr/bin/env bash
set -euo pipefail
# Backward-compat wrapper; use `scripts/auth/sync-whoop.sh` instead.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auth/sync-whoop.sh" "$@"
