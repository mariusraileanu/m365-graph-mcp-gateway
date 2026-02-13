#!/usr/bin/env bash
set -euo pipefail
# Backward-compat wrapper; use `scripts/runtime/provision.sh` instead.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/provision.sh" "$@"
