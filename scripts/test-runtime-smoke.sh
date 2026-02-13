#!/usr/bin/env bash
set -euo pipefail
# Backward-compat wrapper; use `scripts/check/test-runtime.sh` instead.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check/test-runtime.sh" "$@"
