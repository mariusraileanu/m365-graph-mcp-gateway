#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: missing env file: ${ENV_FILE}" >&2
  exit 1
fi

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
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  printf '%s' "$val"
}

is_placeholder_like() {
  local v="${1:-}"
  [[ -z "$v" ]] && return 0
  [[ "$v" =~ ^(changeme|replace_me|your_.*|<.*>)$ ]] && return 0
  [[ "$v" == *"example"* ]] && return 0
  return 1
}

require_nonempty() {
  local key="$1"
  local val
  val="$(get_var "$key")"
  if [[ -z "$val" ]]; then
    echo "Error: required env var is missing/empty: ${key}" >&2
    return 1
  fi
  if is_placeholder_like "$val"; then
    echo "Error: env var looks like a placeholder and must be replaced: ${key}" >&2
    return 1
  fi
  return 0
}

errors=0
for key in OPENCLAW_GATEWAY_AUTH_TOKEN COMPASS_API_KEY TELEGRAM_BOT_TOKEN OPENCLAW_TELEGRAM_TARGET_ID; do
  if ! require_nonempty "$key"; then
    errors=1
  fi
done

legacy_gateway_token="$(get_var OPENCLAW_GATEWAY_TOKEN)"
auth_gateway_token="$(get_var OPENCLAW_GATEWAY_AUTH_TOKEN)"
if [[ -n "$legacy_gateway_token" && -n "$auth_gateway_token" && "$legacy_gateway_token" != "$auth_gateway_token" ]]; then
  echo "Error: OPENCLAW_GATEWAY_TOKEN and OPENCLAW_GATEWAY_AUTH_TOKEN differ." >&2
  echo "Set OPENCLAW_GATEWAY_TOKEN to match, or remove OPENCLAW_GATEWAY_TOKEN entirely." >&2
  errors=1
fi

if [[ "$errors" -ne 0 ]]; then
  exit 1
fi

echo "Env validation passed (${ENV_FILE})"
