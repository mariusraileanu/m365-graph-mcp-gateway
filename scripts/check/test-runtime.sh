#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="${1:-openclaw}"
SKIP_CHECKS="${SKIP_CHECKS:-}"
OPENCLAW_CITY="${OPENCLAW_CITY:-Abu Dhabi}"

should_skip() {
  local name="$1"
  local normalized=",${SKIP_CHECKS// /},"
  [[ "$normalized" == *",$name,"* ]]
}

echo "[1/8] Container exists..."
docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"

echo "[2/8] Container health is healthy..."
health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_NAME")"
if [[ "$health" != "healthy" && "$health" != "none" ]]; then
  echo "Error: container health is '$health'" >&2
  exit 1
fi

echo "[3/8] Gateway status responds..."
docker exec "$CONTAINER_NAME" openclaw status --json >/dev/null

echo "[4/8] Cron wrapper contract smoke test..."
wrapper_json="$(docker exec "$CONTAINER_NAME" sh -lc '/home/node/.openclaw/workspace-cron/bin/oc_exec_json.sh smoke.echo 5 -- /bin/echo ok')"
python3 - <<'PY' "$wrapper_json"
import json
import sys
doc = json.loads(sys.argv[1])
required = ["ok", "source", "exit_code", "timed_out", "stdout", "stderr", "data"]
missing = [k for k in required if k not in doc]
if missing:
    raise SystemExit(f"missing keys: {missing}")
if doc["ok"] is not True or doc["stdout"] != "ok":
    raise SystemExit("wrapper output did not match expected values")
PY

echo "[5/8] Cron jobs file is valid JSON..."
docker exec "$CONTAINER_NAME" sh -lc 'python3 - <<'"'"'PY'"'"'
import json
with open("/home/node/.openclaw/cron/jobs.json", "r", encoding="utf-8") as f:
    doc = json.load(f)
assert isinstance(doc.get("jobs"), list)
print("ok")
PY'

echo "[6/8] Weather helper works..."
docker exec "$CONTAINER_NAME" sh -lc "/home/node/.openclaw/skills/weather/scripts/weather \"${OPENCLAW_CITY}\"" >/dev/null

echo "[7/8] Clippy auth check..."
if should_skip "clippy"; then
  echo "Skipped clippy"
else
  docker exec "$CONTAINER_NAME" clippy whoami >/dev/null
fi

echo "[8/8] WHOOP auth check..."
if should_skip "whoop"; then
  echo "Skipped whoop"
else
  docker exec "$CONTAINER_NAME" sh -lc '/home/node/.openclaw/skills/whoop-central/scripts/whoop-central verify --refresh' >/dev/null
fi

echo "Runtime smoke checks passed."
