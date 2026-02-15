#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERSIONS_FILE="${ROOT_DIR}/config/versions.env"

if [[ ! -f "$VERSIONS_FILE" ]]; then
  echo "ERROR: versions.env not found at $VERSIONS_FILE" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$VERSIONS_FILE"
set +a

errors=0

check_var() {
  local var_name="$1"
  local value="${!var_name}"
  if [[ -z "$value" ]]; then
    echo "ERROR: $var_name is empty" >&2
    errors=$((errors + 1))
  else
    echo "OK: $var_name=$value"
  fi
}

check_var "NODE_VERSION"
check_var "OPENCLAW_REF"
check_var "CLIPPY_REF"
check_var "TAVILY_MCP_VERSION"
check_var "PLAYWRIGHT_MCP_VERSION"
check_var "CLAWHUB_VERSION"
check_var "GOPLACES_VERSION"
check_var "PNPM_VERSION"

if [[ ! "$GOPLACES_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "WARNING: GOPLACES_VERSION should start with 'v'" >&2
fi

if [[ ${#GOPLACES_SHA256_AMD64} -ne 64 ]]; then
  echo "ERROR: GOPLACES_SHA256_AMD64 is not a valid SHA256 (64 chars)" >&2
  errors=$((errors + 1))
fi

if [[ $errors -gt 0 ]]; then
  echo "ERROR: $errors validation check(s) failed" >&2
  exit 1
fi

echo "All versions validated successfully."
