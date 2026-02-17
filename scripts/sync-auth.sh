#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="openclaw"
ENV_FILE=".env"

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key raw || [[ -n "${key:-}" ]]; do
      [[ -z "${key:-}" ]] && continue
      [[ "${key}" =~ ^[[:space:]]*# ]] && continue
      if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        continue
      fi
      value="${raw:-}"
      value="${value%$'\r'}"
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
      export "${key}=${value}"
    done < "$ENV_FILE"
  fi
}

load_env

echo "[1/2] Syncing MS365 MCP auth..."
MS365_SOURCE="${MS365_MCP_TOKEN_CACHE_PATH:-$HOME/.config/ms365-mcp}"
MS365_DEST="./data/ms365"

mkdir -p "$MS365_DEST"

if [[ -f "${MS365_SOURCE}/.token-cache.json" ]]; then
  cp "${MS365_SOURCE}/.token-cache.json" "$MS365_DEST/"
  echo "  MS365 token cache synced."
elif [[ -f "${MS365_SOURCE}/.msal_cache.json" ]]; then
  cp "${MS365_SOURCE}/.msal_cache.json" "$MS365_DEST/"
  echo "  MS365 MSAL cache synced."
else
  echo "  NOTE: MS365 auth not found at ${MS365_SOURCE}. Run 'make ms365-login' to authenticate."
fi

chmod 600 "$MS365_DEST"/*.json 2>/dev/null || true

echo "[2/2] Syncing Whoop auth from .env..."
WHOOP_DEST="./data/whoop"
mkdir -p "$WHOOP_DEST"

if [[ -n "${WHOOP_CLIENT_ID:-}" && -n "${WHOOP_CLIENT_SECRET:-}" ]]; then
  cat > "${WHOOP_DEST}/credentials.json" <<EOF
{
  "clientId": "${WHOOP_CLIENT_ID}",
  "clientSecret": "${WHOOP_CLIENT_SECRET}"
}
EOF
  echo "  Whoop credentials written."
else
  echo "  WARNING: WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET not set in .env"
fi

if [[ -n "${WHOOP_PASSWORD:-}" && -n "${WHOOP_EMAIL:-}" ]]; then
  cat > "${WHOOP_DEST}/password.json" <<EOF
{
  "email": "${WHOOP_EMAIL}",
  "password": "${WHOOP_PASSWORD}"
}
EOF
  echo "  Whoop password auth written."
fi

chmod 600 "$WHOOP_DEST"/*.json 2>/dev/null || true
echo "Auth sync complete."
