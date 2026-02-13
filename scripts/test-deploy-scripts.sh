#!/usr/bin/env bash
set -euo pipefail
# Backward-compat wrapper; use `scripts/check/test-deploy.sh` instead.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check/test-deploy.sh" "$@"
