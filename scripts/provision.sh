#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="openclaw"

echo "=== OpenClaw Provision ==="

# Validate .env exists
if [[ ! -f .env ]]; then
  echo "ERROR: .env file not found. Copy .env_example to .env and configure."
  exit 1
fi

get_env_var() {
  local key="$1"
  python3 - "$key" <<'PY'
import re
import sys

target = sys.argv[1]
values = {}

with open(".env", "r", encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k):
            continue
        v = v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        values[k] = v

print(values.get(target, ""))
PY
}

# Check required vars
REQUIRED_VARS="COMPASS_API_KEY TELEGRAM_BOT_TOKEN OPENCLAW_GATEWAY_AUTH_TOKEN OPENCLAW_TELEGRAM_TARGET_ID GRAPH_MCP_CLIENT_ID GRAPH_MCP_TENANT_ID"
for var in $REQUIRED_VARS; do
  value="$(get_env_var "$var")"
  if [[ -z "$value" ]]; then
    echo "ERROR: $var is not set in .env"
    exit 1
  fi
done

OPENCLAW_GATEWAY_AUTH_TOKEN="$(get_env_var OPENCLAW_GATEWAY_AUTH_TOKEN)"
OPENCLAW_WHATSAPP_ENABLED="$(get_env_var OPENCLAW_WHATSAPP_ENABLED)"
OPENCLAW_WHATSAPP_DM_POLICY="$(get_env_var OPENCLAW_WHATSAPP_DM_POLICY)"
OPENCLAW_WHATSAPP_ALLOW_FROM="$(get_env_var OPENCLAW_WHATSAPP_ALLOW_FROM)"
OPENCLAW_WHATSAPP_GROUP_POLICY="$(get_env_var OPENCLAW_WHATSAPP_GROUP_POLICY)"
OPENCLAW_WHATSAPP_GROUP_ALLOW_FROM="$(get_env_var OPENCLAW_WHATSAPP_GROUP_ALLOW_FROM)"
OPENCLAW_SIGNAL_ENABLED="$(get_env_var OPENCLAW_SIGNAL_ENABLED)"
OPENCLAW_SIGNAL_ACCOUNT="$(get_env_var OPENCLAW_SIGNAL_ACCOUNT)"
OPENCLAW_SIGNAL_CLI_PATH="$(get_env_var OPENCLAW_SIGNAL_CLI_PATH)"
OPENCLAW_SIGNAL_HTTP_URL="$(get_env_var OPENCLAW_SIGNAL_HTTP_URL)"
OPENCLAW_SIGNAL_DM_POLICY="$(get_env_var OPENCLAW_SIGNAL_DM_POLICY)"
OPENCLAW_SIGNAL_ALLOW_FROM="$(get_env_var OPENCLAW_SIGNAL_ALLOW_FROM)"
OPENCLAW_SIGNAL_GROUP_POLICY="$(get_env_var OPENCLAW_SIGNAL_GROUP_POLICY)"
OPENCLAW_SIGNAL_GROUP_ALLOW_FROM="$(get_env_var OPENCLAW_SIGNAL_GROUP_ALLOW_FROM)"

# Ensure directories
mkdir -p data/.openclaw data/workspace data/graph-mcp data/ms365 data/whoop data/signal
NODE_UID="${OPENCLAW_DATA_UID:-1000}"
NODE_GID="${OPENCLAW_DATA_GID:-1000}"

# Initialize config if not exists
if [[ ! -f data/.openclaw/openclaw.json ]]; then
  cp config/openclaw.json.example data/.openclaw/openclaw.json
  chmod 600 data/.openclaw/openclaw.json
fi

# Update config with gateway token + Graph MCP command allowlist
python3 - <<PY
import json

cfg_path = "data/.openclaw/openclaw.json"
token = "${OPENCLAW_GATEWAY_AUTH_TOKEN}"
whatsapp_dm_policy = "${OPENCLAW_WHATSAPP_DM_POLICY}".strip() or "pairing"
whatsapp_allow_from = "${OPENCLAW_WHATSAPP_ALLOW_FROM}".strip()
whatsapp_group_policy = "${OPENCLAW_WHATSAPP_GROUP_POLICY}".strip() or "allowlist"
whatsapp_group_allow_from = "${OPENCLAW_WHATSAPP_GROUP_ALLOW_FROM}".strip()
signal_enabled_raw = "${OPENCLAW_SIGNAL_ENABLED}".strip().lower()
signal_account = "${OPENCLAW_SIGNAL_ACCOUNT}".strip()
signal_cli_path = "${OPENCLAW_SIGNAL_CLI_PATH}".strip() or "signal-cli"
signal_http_url = "${OPENCLAW_SIGNAL_HTTP_URL}".strip()
signal_dm_policy = "${OPENCLAW_SIGNAL_DM_POLICY}".strip() or "pairing"
signal_allow_from = "${OPENCLAW_SIGNAL_ALLOW_FROM}".strip()
signal_group_policy = "${OPENCLAW_SIGNAL_GROUP_POLICY}".strip() or "allowlist"
signal_group_allow_from = "${OPENCLAW_SIGNAL_GROUP_ALLOW_FROM}".strip()

def parse_csv(value: str):
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]

def parse_bool(value: str, default: bool = False):
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}

with open(cfg_path, "r") as f:
    obj = json.load(f)

obj.setdefault("gateway", {})
obj["gateway"]["mode"] = "local"
obj["gateway"]["bind"] = "loopback"
obj["gateway"].setdefault("auth", {})["mode"] = "token"
obj["gateway"]["auth"]["token"] = token
obj["gateway"].setdefault("remote", {})["token"] = token

tools = obj.setdefault("tools", {})
web_cfg = tools.setdefault("web", {})
web_cfg.setdefault("search", {})["enabled"] = False
web_cfg.setdefault("fetch", {})["enabled"] = False
exec_cfg = tools.setdefault("exec", {})
exec_cfg.setdefault("host", "gateway")
exec_cfg.setdefault("security", "allowlist")
exec_cfg["ask"] = "off"

path_prepend = exec_cfg.setdefault("pathPrepend", [])
path_prepend = [
    "/home/node/workspace/bin",
    "/home/node/.openclaw/tools/npm-global/bin",
]
exec_cfg["pathPrepend"] = path_prepend

safe_bins = exec_cfg.setdefault("safeBins", [])
safe_bins = [b for b in safe_bins if b not in ("clippy", "whoop-central", "self-improving-agent")]
for tool in (
    "graph-mcp", "graph-mcp-write", "graph-mcp-send",
    "mail-unread", "mail-read", "mail-search", "mail-draft", "mail-draft-reply-all", "mail-send",
    "calendar-next", "calendar-read", "calendar-today", "calendar-tomorrow", "calendar-week", "calendar-free", "calendar-create", "calendar-respond", "meeting-radar",
    "sharepoint-file-search", "sharepoint-file-name-search", "sharepoint-file-content-search",
    "tavily-search", "tavily-extract", "summarize", "weather", "node", "curl", "npx", "playwright-mcp"
):
    if tool not in safe_bins:
        safe_bins.append(tool)
exec_cfg["safeBins"] = safe_bins

skills_cfg = obj.setdefault("skills", {})
entries = skills_cfg.setdefault("entries", {})
entries.setdefault("tavily", {})["enabled"] = True

channels_cfg = obj.setdefault("channels", {})
whatsapp_cfg = channels_cfg.setdefault("whatsapp", {})
whatsapp_cfg["dmPolicy"] = whatsapp_dm_policy
whatsapp_cfg["allowFrom"] = parse_csv(whatsapp_allow_from)
whatsapp_cfg["groupPolicy"] = whatsapp_group_policy
whatsapp_cfg["groupAllowFrom"] = parse_csv(whatsapp_group_allow_from)

plugins_cfg = obj.setdefault("plugins", {})
plugins_entries = plugins_cfg.setdefault("entries", {})
plugins_entries.setdefault("whatsapp", {})["enabled"] = True

signal_enabled = parse_bool(signal_enabled_raw, False) and bool(signal_account or signal_http_url)
channels_cfg = obj.setdefault("channels", {})
signal_cfg = channels_cfg.setdefault("signal", {})
signal_cfg["enabled"] = signal_enabled
if signal_enabled:
    signal_cfg["account"] = signal_account
    signal_cfg["cliPath"] = signal_cli_path
    if signal_http_url:
        signal_cfg["httpUrl"] = signal_http_url
        signal_cfg["autoStart"] = False
    else:
        signal_cfg.pop("httpUrl", None)
        signal_cfg.pop("autoStart", None)
    signal_cfg["dmPolicy"] = signal_dm_policy
    signal_cfg["allowFrom"] = parse_csv(signal_allow_from)
    signal_cfg["groupPolicy"] = signal_group_policy
    signal_cfg["groupAllowFrom"] = parse_csv(signal_group_allow_from)
else:
    signal_cfg["account"] = signal_account
    signal_cfg["cliPath"] = signal_cli_path
    signal_cfg.pop("httpUrl", None)
    signal_cfg.pop("autoStart", None)

plugins_entries.setdefault("signal", {})["enabled"] = signal_enabled

with open(cfg_path, "w") as f:
    json.dump(obj, f, indent=2)

print("Config updated.")
PY

chmod 600 data/.openclaw/openclaw.json

# Sync workspace from templates (both mounted workspace and OpenClaw internal workspace)
echo "Syncing workspace..."
mkdir -p data/workspace data/.openclaw/workspace
for f in templates/workspace/*.md; do
  [[ -f "$f" ]] && cp "$f" data/workspace/ && cp "$f" data/.openclaw/workspace/
done
if compgen -G "templates/workspace/bin/*" > /dev/null; then
  mkdir -p data/workspace/bin
  rm -f data/workspace/bin/*
  cp templates/workspace/bin/* data/workspace/bin/
  chmod +x data/workspace/bin/*
fi
if [[ -d templates/workspace/automation ]]; then
  mkdir -p data/workspace/automation data/.openclaw/workspace/automation
  cp -R templates/workspace/automation/. data/workspace/automation/
  cp -R templates/workspace/automation/. data/.openclaw/workspace/automation/
fi

# Ensure container user can read/write mounted state.
chown -R "${NODE_UID}:${NODE_GID}" data/.openclaw data/workspace data/graph-mcp data/ms365 data/whoop data/signal 2>/dev/null || true
chmod 600 data/.openclaw/openclaw.json 2>/dev/null || true

# Restart container
echo "Restarting container..."
if [[ "${OPENCLAW_SIGNAL_ENABLED,,}" == "true" || "${OPENCLAW_SIGNAL_ENABLED,,}" == "1" || "${OPENCLAW_SIGNAL_ENABLED,,}" == "yes" ]]; then
  docker compose --profile signal up -d --force-recreate
else
  docker compose up -d --force-recreate
fi

# Wait for healthy
echo "Waiting for container..."
for i in {1..45}; do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "none")
  if [[ "$status" == "healthy" ]]; then
    echo "Container is healthy."
    echo "Ensuring skills..."
    bash scripts/setup-skills.sh
    echo "Ensuring cron jobs..."
    bash scripts/setup-cron.sh
    exit 0
  fi
  sleep 2
done

echo "WARNING: Container did not become healthy within 90s"
docker logs --tail 20 "$CONTAINER_NAME" || true
exit 1
