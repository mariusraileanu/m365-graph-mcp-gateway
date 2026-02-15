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
if errors:
    print("Config secret validation failed:", file=sys.stderr)
    for e in errors:
        print(f"- {e}", file=sys.stderr)
    sys.exit(1)
PY
}

sync_gateway_runtime_config() {
  local cfg_path="./data/.openclaw/openclaw.json"
  local gateway_token="$1"
  if [[ ! -f "$cfg_path" ]]; then
    echo "Error: missing runtime config: $cfg_path" >&2
    exit 1
  fi

  python3 - "$cfg_path" "$gateway_token" <<'PY'
import json
import sys

cfg_path = sys.argv[1]
token = sys.argv[2]

with open(cfg_path, "r", encoding="utf-8") as f:
    obj = json.load(f)

gateway = obj.setdefault("gateway", {})
gateway.setdefault("mode", "local")
gateway.setdefault("bind", "loopback")
auth = gateway.setdefault("auth", {})
auth["mode"] = "token"
auth["token"] = token
remote = gateway.setdefault("remote", {})
remote["token"] = token

tools = obj.setdefault("tools", {})
exec_cfg = tools.setdefault("exec", {})
safe_bins = exec_cfg.setdefault("safeBins", [])
required_bins = [
    "oc_exec_json.sh",
    "oc_whoop_today_json",
    "oc_calendar_today_json",
    "oc_calendar_tomorrow_json",
    "oc_email_unread_json",
    "oc_weather_local_json",
    "oc_news_ai_health_json",
]
for b in required_bins:
    if b not in safe_bins:
        safe_bins.append(b)

with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(obj, f, indent=2)
    f.write("\n")
PY
  chmod 600 "$cfg_path" || true
}

ENV_FILE="${1:-.env}"

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

"${SCRIPTS_DIR}/check/validate-env.sh" "$ENV_FILE"

mkdir -p ./data/.openclaw/workspace-cron ./data/.openclaw/agents/cron/agent ./data/.openclaw/agents/main/sessions
"${SCRIPTS_DIR}/cron/sync-workspace.sh" --type main ./data/workspace
"${SCRIPTS_DIR}/cron/sync-workspace.sh" --type cron

OPENCLAW_PROFILE="${OPENCLAW_PROFILE:-secure}"
CONTAINER_NAME="${2:-openclaw}"
gateway_token="${OPENCLAW_GATEWAY_AUTH_TOKEN:-}"
if [[ -z "$gateway_token" && -f "$ENV_FILE" ]]; then
  gateway_token="$(grep -m1 '^OPENCLAW_GATEWAY_AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
  gateway_token="${gateway_token%\"}"
  gateway_token="${gateway_token#\"}"
  gateway_token="${gateway_token%\'}"
  gateway_token="${gateway_token#\'}"
fi

if [[ -z "$gateway_token" ]]; then
  echo "Error: OPENCLAW_GATEWAY_AUTH_TOKEN is missing or empty." >&2
  echo "Set it in ${ENV_FILE} (or export it) before provisioning." >&2
  exit 1
fi

validate_runtime_secrets
sync_gateway_runtime_config "$gateway_token"

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
OPENCLAW_REQUIRE_CLIPPY_SYNC="${OPENCLAW_REQUIRE_CLIPPY_SYNC:-0}"
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

echo "[1/8] Backing up runtime state..."
"${SCRIPTS_DIR}/runtime/backup-state.sh" "./data/.openclaw/backups"

echo "[2/8] Syncing Clippy auth files..."
clippy_source_dir="${CLIPPY_HOST_PROFILE_DIR:-./data/clippy}"
clippy_sync_ok=1
if ! "${SCRIPTS_DIR}/auth/sync-clippy.sh" "$CONTAINER_NAME" "$clippy_source_dir" "./data/clippy"; then
  clippy_sync_ok=0
  if [[ "$OPENCLAW_REQUIRE_CLIPPY_SYNC" == "1" ]]; then
    echo "Error: Clippy sync failed and OPENCLAW_REQUIRE_CLIPPY_SYNC=1." >&2
    exit 1
  fi
  echo "Warning: Clippy sync failed; continuing without Clippy auth."
fi

echo "[3/8] Syncing WHOOP auth from .env..."
"${SCRIPTS_DIR}/auth/sync-whoop.sh" "$ENV_FILE" "./data/whoop" "$CONTAINER_NAME"

echo "[4/8] Syncing cron workspace..."
"${SCRIPTS_DIR}/cron/sync-workspace.sh" --type cron

echo "[5/8] Syncing cron tooling..."
"${SCRIPTS_DIR}/cron/sync-tooling.sh" "./data/.openclaw/workspace-cron"

echo "[6/8] Recreating container..."
docker compose up -d --force-recreate
wait_for_healthy "$CONTAINER_NAME" "$OPENCLAW_HEALTH_TIMEOUT_SEC"
"${SCRIPTS_DIR}/runtime/harden-state-permissions.sh" "$CONTAINER_NAME" 2>/dev/null || true

echo "[7/8] Quick auth checks..."
if [[ "$clippy_sync_ok" == "1" ]]; then
  run_auth_check "clippy" "Clippy auth" "clippy whoami"
else
  echo "Skipped Clippy auth check (sync failed)."
fi
run_auth_check "whoop" "WHOOP auth" "whoop-central verify --refresh"
docker exec "$CONTAINER_NAME" sh -lc "weather '${OPENCLAW_CITY}'" || true

echo "[8/8] Runtime smoke checks..."
SKIP_CHECKS="$OPENCLAW_SKIP_AUTH_CHECKS" "${SCRIPTS_DIR}/check/test-runtime.sh" "$CONTAINER_NAME"

echo "Done. Provision complete."
