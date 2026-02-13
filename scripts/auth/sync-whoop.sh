#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=../lib/common.sh
source "${ROOT_DIR}/scripts/lib/common.sh"

ENV_FILE="${1:-.env}"
DEST_WHOOP_DIR="${2:-./data/whoop}"
CONTAINER_NAME="${3:-openclaw}"
CONTAINER_WHOOP_DIR="/home/node/.clawdbot/whoop"

get_var() {
  local key="$1"
  local val="${!key:-}"
  if [[ -z "$val" && -f "$ENV_FILE" ]]; then
    local line
    line="$(grep -m1 "^${key}=" "$ENV_FILE" || true)"
    if [[ -n "$line" ]]; then
      val="${line#*=}"
    fi
  fi
  # Trim optional surrounding quotes and CR/LF from pasted values.
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  val="${val//$'\r'/}"
  val="${val//$'\n'/}"
  printf '%s' "$val"
}

client_id="$(get_var WHOOP_CLIENT_ID)"
client_secret="$(get_var WHOOP_CLIENT_SECRET)"
access_token="$(get_var WHOOP_ACCESS_TOKEN)"
refresh_token="$(get_var WHOOP_REFRESH_TOKEN)"
redirect_uri="$(get_var WHOOP_REDIRECT_URI)"
obtained_at="$(get_var WHOOP_OBTAINED_AT)"
if [[ -z "$obtained_at" ]]; then
  obtained_at="$(get_var WHOOP_OBTAINED_AT_MS)"
fi
expires_in="$(get_var WHOOP_EXPIRES_IN)"
scope="$(get_var WHOOP_SCOPES)"
if [[ -z "$scope" ]]; then
  scope="$(get_var WHOOP_SCOPE)"
fi

if [[ -z "$obtained_at" ]]; then
  obtained_at="$(($(date +%s) * 1000))"
fi
if [[ -z "$expires_in" ]]; then
  expires_in="3600"
fi

ensure_dir_secure "$DEST_WHOOP_DIR"

# If redirect URI is not explicitly provided, preserve previously stored value if available.
if [[ -z "$redirect_uri" && -f "${DEST_WHOOP_DIR}/token.json" ]]; then
  redirect_uri="$(
    node -e '
      const fs = require("fs");
      try {
        const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(typeof t.redirect_uri === "string" ? t.redirect_uri : "");
      } catch { process.stdout.write(""); }
    ' "${DEST_WHOOP_DIR}/token.json"
  )"
fi

if [[ -n "$client_id" && -n "$client_secret" ]]; then
  cat > "${DEST_WHOOP_DIR}/credentials.json" <<EOF
{
  "client_id": "${client_id}",
  "client_secret": "${client_secret}"
}
EOF
  ensure_file_secure "${DEST_WHOOP_DIR}/credentials.json"
  echo "Wrote ${DEST_WHOOP_DIR}/credentials.json"
else
  echo "Skipped credentials.json (WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET missing)."
fi

if [[ -n "$access_token" && -n "$refresh_token" ]]; then
  token_json="$(
    WHOOP_ACCESS_TOKEN="$access_token" \
    WHOOP_REFRESH_TOKEN="$refresh_token" \
    WHOOP_EXPIRES_IN="$expires_in" \
    WHOOP_OBTAINED_AT="$obtained_at" \
    WHOOP_REDIRECT_URI="$redirect_uri" \
    WHOOP_SCOPE="$scope" \
    node -e '
      const data = {
        access_token: process.env.WHOOP_ACCESS_TOKEN,
        refresh_token: process.env.WHOOP_REFRESH_TOKEN,
        token_type: "Bearer",
        expires_in: Number(process.env.WHOOP_EXPIRES_IN || "3600"),
        obtained_at: Number(process.env.WHOOP_OBTAINED_AT || String(Date.now()))
      };
      if (process.env.WHOOP_REDIRECT_URI) data.redirect_uri = process.env.WHOOP_REDIRECT_URI;
      if (process.env.WHOOP_SCOPE) data.scope = process.env.WHOOP_SCOPE;
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    '
  )"
  cat > "${DEST_WHOOP_DIR}/token.json" <<EOF
${token_json}
EOF
  if [[ -z "$redirect_uri" ]]; then
    # Ensure redirect_uri is absent (rather than forced) when not explicitly known.
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const t = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!t.redirect_uri) delete t.redirect_uri;
      fs.writeFileSync(p, JSON.stringify(t, null, 2) + "\n");
    ' "${DEST_WHOOP_DIR}/token.json"
  fi
  ensure_file_secure "${DEST_WHOOP_DIR}/token.json"
  echo "Wrote ${DEST_WHOOP_DIR}/token.json"
else
  echo "Skipped token.json (WHOOP_ACCESS_TOKEN/WHOOP_REFRESH_TOKEN missing)."
fi

if command -v docker >/dev/null 2>&1 && container_running "${CONTAINER_NAME}"; then
  docker exec "${CONTAINER_NAME}" sh -lc "mkdir -p '${CONTAINER_WHOOP_DIR}' && chmod 700 '${CONTAINER_WHOOP_DIR}'"
  if [[ -f "${DEST_WHOOP_DIR}/credentials.json" ]]; then
    cat "${DEST_WHOOP_DIR}/credentials.json" | docker exec -i "${CONTAINER_NAME}" sh -lc "umask 077; cat > '${CONTAINER_WHOOP_DIR}/credentials.json'"
  fi
  if [[ -f "${DEST_WHOOP_DIR}/token.json" ]]; then
    cat "${DEST_WHOOP_DIR}/token.json" | docker exec -i "${CONTAINER_NAME}" sh -lc "umask 077; cat > '${CONTAINER_WHOOP_DIR}/token.json'"
  fi
  echo "Synced WHOOP auth files to running container: ${CONTAINER_NAME}:${CONTAINER_WHOOP_DIR}"
fi

echo "Next check: docker exec ${CONTAINER_NAME} sh -lc \"/home/node/.openclaw/skills/whoop-central/scripts/whoop-central verify --refresh\""
