#!/usr/bin/env bash
set -euo pipefail
# Backward-compat wrapper; use `scripts/setup/init-config.sh` instead.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup/init-config.sh" "$@"
