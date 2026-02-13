#!/usr/bin/env bash
set -euo pipefail
# Backward-compat wrapper; use `scripts/auth/sync-clippy.sh` instead.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auth/sync-clippy.sh" "$@"
