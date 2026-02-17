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
REQUIRED_VARS="COMPASS_API_KEY TELEGRAM_BOT_TOKEN OPENCLAW_GATEWAY_AUTH_TOKEN OPENCLAW_TELEGRAM_TARGET_ID"
for var in $REQUIRED_VARS; do
  value="$(get_env_var "$var")"
  if [[ -z "$value" ]]; then
    echo "ERROR: $var is not set in .env"
    exit 1
  fi
done

OPENCLAW_GATEWAY_AUTH_TOKEN="$(get_env_var OPENCLAW_GATEWAY_AUTH_TOKEN)"

# Ensure directories
mkdir -p data/.openclaw data/workspace data/graph-mcp data/ms365 data/whoop

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
    "tavily-search", "tavily-extract", "summarize", "node", "curl", "npx", "playwright-mcp"
):
    if tool not in safe_bins:
        safe_bins.append(tool)
exec_cfg["safeBins"] = safe_bins

skills_cfg = obj.setdefault("skills", {})
entries = skills_cfg.setdefault("entries", {})
entries.setdefault("tavily", {})["enabled"] = True

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

# Restart container
echo "Restarting container..."
docker compose up -d --force-recreate

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
