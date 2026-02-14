#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SCRIPTS_DIR="${ROOT_DIR}/scripts"

cd "$ROOT_DIR"

"${SCRIPTS_DIR}/check/validate-prereqs.sh"

validate_runtime_secrets() {
  local cfg_path="./data/.openclaw/openclaw.json"
  if [[ ! -f "$cfg_path" ]]; then
    echo "Error: missing runtime config: $cfg_path" >&2
    exit 1
  fi

  python3 - "$cfg_path" <<'PY'
import json
import re
import sys

cfg_path = sys.argv[1]
with open(cfg_path, "r", encoding="utf-8") as f:
    obj = json.load(f)

placeholder = re.compile(r"^\$\{[A-Z0-9_]+\}$")
errors = []

def is_placeholder(v):
    return isinstance(v, str) and bool(placeholder.match(v.strip()))

providers = ((obj.get("models") or {}).get("providers") or {})
for provider_name, provider_cfg in providers.items():
    api_key = (provider_cfg or {}).get("apiKey")
    if api_key is None:
        continue
    if not is_placeholder(api_key):
        errors.append(f"models.providers.{provider_name}.apiKey must use an env placeholder (found plaintext)")

gateway = obj.get("gateway") or {}
auth_token = (gateway.get("auth") or {}).get("token")
remote_token = (gateway.get("remote") or {}).get("token")
if auth_token is not None and not is_placeholder(auth_token):
    errors.append("gateway.auth.token must use an env placeholder (found plaintext)")
if remote_token is not None and not is_placeholder(remote_token):
    errors.append("gateway.remote.token must use an env placeholder (found plaintext)")

if errors:
    print("Config secret validation failed:", file=sys.stderr)
    for e in errors:
        print(f"- {e}", file=sys.stderr)
    sys.exit(1)
PY
}

ENV_FILE="${4:-.env}"
"${SCRIPTS_DIR}/check/validate-env.sh" "$ENV_FILE"

mkdir -p ./data/.openclaw/workspace-cron ./data/.openclaw/agents/cron/agent
"${SCRIPTS_DIR}/cron/sync-workspace.sh" "./data/.openclaw/workspace-cron"

gateway_token="${OPENCLAW_GATEWAY_AUTH_TOKEN:-}"
OPENCLAW_PROFILE="${OPENCLAW_PROFILE:-secure}"
CONTAINER_NAME="${1:-openclaw}"
if [[ -z "$gateway_token" && -f "$ENV_FILE" ]]; then
  gateway_token="$(grep -m1 '^OPENCLAW_GATEWAY_AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
  gateway_token="${gateway_token%\"}"
  gateway_token="${gateway_token#\"}"
  gateway_token="${gateway_token%\'}"
  gateway_token="${gateway_token#\'}"
fi

if [[ -z "$gateway_token" ]]; then
  echo "Error: OPENCLAW_GATEWAY_AUTH_TOKEN is missing or empty." >&2
  echo "Set it in ${ENV_FILE} (or export it) before recreating." >&2
  exit 1
fi

validate_runtime_secrets

if [[ "$OPENCLAW_PROFILE" == "local-dev" ]]; then
  if [[ -f "./data/.openclaw/openclaw.local-dev.json" ]]; then
    cp "./data/.openclaw/openclaw.local-dev.json" "./data/.openclaw/openclaw.json"
    chmod 600 "./data/.openclaw/openclaw.json" || true
    echo "Profile override applied: local-dev -> data/.openclaw/openclaw.json"
  else
    echo "Error: OPENCLAW_PROFILE=local-dev but ./data/.openclaw/openclaw.local-dev.json is missing." >&2
    exit 1
  fi
elif [[ "$OPENCLAW_PROFILE" != "secure" ]]; then
  echo "Error: OPENCLAW_PROFILE must be 'secure' or 'local-dev' (got '$OPENCLAW_PROFILE')." >&2
  exit 1
fi

OPENCLAW_HEALTH_TIMEOUT_SEC="${OPENCLAW_HEALTH_TIMEOUT_SEC:-90}"
OPENCLAW_SKIP_AUTH_CHECKS="${OPENCLAW_SKIP_AUTH_CHECKS:-}"
OPENCLAW_CITY="${OPENCLAW_CITY:-Abu Dhabi}"
"${SCRIPTS_DIR}/check/validate-secure-profile.sh"

should_skip_check() {
  local check_name="$1"
  if [[ -z "$OPENCLAW_SKIP_AUTH_CHECKS" ]]; then
    return 1
  fi
  local normalized=",$(printf "%s" "$OPENCLAW_SKIP_AUTH_CHECKS" | tr -d '[:space:]'),"
  [[ "$normalized" == *",$check_name,"* ]]
}

run_auth_check() {
  local check_name="$1"
  local desc="$2"
  local cmd="$3"

  if should_skip_check "$check_name"; then
    echo "Skipped ${desc} (OPENCLAW_SKIP_AUTH_CHECKS includes '${check_name}')"
    return 0
  fi

  echo "Checking ${desc}..."
  if ! docker exec "$CONTAINER_NAME" sh -lc "$cmd"; then
    echo "Error: ${desc} failed." >&2
    echo "To bypass temporarily: OPENCLAW_SKIP_AUTH_CHECKS=${check_name} ./scripts/provision-openclaw.sh" >&2
    exit 1
  fi
}

wait_for_healthy() {
  local container_name="${1:-openclaw}"
  local timeout_sec="${2:-90}"
  local elapsed=0
  local status

  while [[ "$elapsed" -lt "$timeout_sec" ]]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null || true)"
    case "$status" in
      healthy)
        echo "Container health: healthy"
        return 0
        ;;
      none)
        echo "Container has no healthcheck; continuing."
        return 0
        ;;
      *)
        sleep 2
        elapsed=$((elapsed + 2))
        ;;
    esac
  done

  echo "Error: container '${container_name}' did not become healthy within ${timeout_sec}s." >&2
  docker ps -a --filter "name=${container_name}" --format 'table {{.Names}}\t{{.Status}}' || true
  exit 1
}

echo "[1/15] Backing up runtime state..."
"${SCRIPTS_DIR}/runtime/backup-state.sh" "./data/.openclaw/backups"

echo "[2/15] Syncing Clippy auth files..."
"${SCRIPTS_DIR}/auth/sync-clippy.sh" "$CONTAINER_NAME" "${2:-${CLIPPY_HOST_PROFILE_DIR:-}}" "${3:-./data/clippy}"

echo "[3/15] Syncing WHOOP auth files from .env..."
"${SCRIPTS_DIR}/auth/sync-whoop.sh" "${4:-.env}" "${5:-./data/whoop}" "$CONTAINER_NAME"

echo "[4/15] Syncing Weather skill..."
"${SCRIPTS_DIR}/skills/sync-weather.sh" "${6:-./data/.openclaw/skills/weather}" "${7:-./data/.openclaw/skills/weather/scripts/weather}"

echo "[5/15] Syncing Self-Improving skill..."
"${SCRIPTS_DIR}/skills/sync-self-improving.sh" "${8:-./data/.openclaw}" "${9:-skills}" "${10:-self-improving-agent}" "${11:-./data/workspace}"

echo "[6/15] Syncing goplaces skill..."
"${SCRIPTS_DIR}/skills/sync-goplaces.sh" "${12:-./data/.openclaw}" "${13:-skills}" "${14:-goplaces}" "${4:-.env}"

echo "[7/15] Syncing playwright-mcp skill..."
"${SCRIPTS_DIR}/skills/sync-playwright-mcp.sh" "${12:-./data/.openclaw}" "${13:-skills}" "${15:-playwright-mcp}"

echo "[8/15] Syncing cron workspace personalization..."
"${SCRIPTS_DIR}/cron/sync-workspace.sh" "./data/.openclaw/workspace-cron"

echo "[9/15] Syncing cron tooling wrappers..."
"${SCRIPTS_DIR}/cron/sync-tooling.sh" "./data/.openclaw/workspace-cron"

echo "[10/15] Syncing morning briefing cron template..."
"${SCRIPTS_DIR}/cron/sync-morning-brief.sh" "${16:-./data/.openclaw/cron/jobs.json}"

echo "[11/15] Syncing evening reflection cron template..."
"${SCRIPTS_DIR}/cron/sync-evening-reflection.sh" "${16:-./data/.openclaw/cron/jobs.json}"

echo "[12/15] Recreating container..."
docker compose up -d --force-recreate
wait_for_healthy "$CONTAINER_NAME" "$OPENCLAW_HEALTH_TIMEOUT_SEC"
"${SCRIPTS_DIR}/runtime/fix-browser-profile-lock.sh" "$CONTAINER_NAME"
"${SCRIPTS_DIR}/runtime/harden-state-permissions.sh" "$CONTAINER_NAME"

echo "[13/15] Quick auth checks..."
run_auth_check "clippy" "Clippy auth" "clippy whoami"
run_auth_check "whoop" "WHOOP auth refresh" "/home/node/.openclaw/skills/whoop-central/scripts/whoop-central verify --refresh"
docker exec "$CONTAINER_NAME" sh -lc "/home/node/.openclaw/skills/weather/scripts/weather '${OPENCLAW_CITY}'" || true
docker exec "$CONTAINER_NAME" sh -lc "test -f /home/node/.openclaw/skills/self-improving-agent/SKILL.md && echo 'self-improving-agent installed'" || true
docker exec "$CONTAINER_NAME" sh -lc "test -f /home/node/.openclaw/skills/goplaces/SKILL.md && goplaces --help >/dev/null && echo 'goplaces installed'" || true
docker exec "$CONTAINER_NAME" sh -lc "test -f /home/node/.openclaw/skills/playwright-mcp/SKILL.md && playwright-mcp --version >/dev/null && echo 'playwright-mcp installed'" || true

echo "[14/15] Writing runtime diagnostics snapshot..."
"${SCRIPTS_DIR}/runtime/collect-diagnostics.sh" "$CONTAINER_NAME"

echo "[15/15] Runtime smoke checks..."
SKIP_CHECKS="$OPENCLAW_SKIP_AUTH_CHECKS" "${SCRIPTS_DIR}/check/test-runtime.sh" "$CONTAINER_NAME"

echo "Done."
