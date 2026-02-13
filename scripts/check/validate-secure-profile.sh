#!/usr/bin/env bash
set -euo pipefail

PROFILE="${OPENCLAW_PROFILE:-secure}"
SKIP_AUTH="${OPENCLAW_SKIP_AUTH_CHECKS:-}"
ALLOW_INSECURE="${OPENCLAW_ALLOW_INSECURE_BYPASS:-0}"

if [[ "$PROFILE" == "secure" ]]; then
  if [[ -n "$SKIP_AUTH" && "$ALLOW_INSECURE" != "1" ]]; then
    echo "Error: OPENCLAW_SKIP_AUTH_CHECKS is not allowed in secure profile by default." >&2
    echo "Set OPENCLAW_ALLOW_INSECURE_BYPASS=1 only for temporary break-glass runs." >&2
    exit 1
  fi
fi

echo "Secure profile validation passed."
