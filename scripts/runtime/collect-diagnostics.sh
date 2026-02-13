#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="${1:-openclaw}"
OUT_DIR="${2:-./data/.openclaw/diagnostics}"
LOG_LINES="${3:-300}"

mkdir -p "$OUT_DIR"

timestamp_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
epoch="$(date +%s)"
out_file="${OUT_DIR}/runtime-${epoch}.json"
latest_file="${OUT_DIR}/latest.json"

container_state="$(docker inspect "$CONTAINER_NAME" --format '{{json .State}}' 2>/dev/null || echo '{}')"
container_config="$(docker inspect "$CONTAINER_NAME" --format '{{json .Config}}' 2>/dev/null || echo '{}')"
container_host_cfg="$(docker inspect "$CONTAINER_NAME" --format '{{json .HostConfig}}' 2>/dev/null || echo '{}')"
container_ports="$(docker inspect "$CONTAINER_NAME" --format '{{json .NetworkSettings.Ports}}' 2>/dev/null || echo '{}')"

error_log_file="$(mktemp)"
docker logs --tail "$LOG_LINES" "$CONTAINER_NAME" 2>&1 \
  | grep -E -i '(^|[^a-z])(error|failed|panic|exception|unauthorized|forbidden|429|401|timeout)($|[^a-z])' \
  | tail -n 80 >"$error_log_file" || true

python3 - "$out_file" "$timestamp_utc" "$CONTAINER_NAME" "$container_state" "$container_config" "$container_host_cfg" "$container_ports" "$error_log_file" <<'PY'
import json
import sys
from pathlib import Path

out_file = Path(sys.argv[1])
timestamp = sys.argv[2]
container = sys.argv[3]
state = json.loads(sys.argv[4] or "{}")
config = json.loads(sys.argv[5] or "{}")
host_cfg = json.loads(sys.argv[6] or "{}")
ports = json.loads(sys.argv[7] or "{}")
errors_path = Path(sys.argv[8])
error_lines = [line.rstrip("\n") for line in errors_path.read_text(encoding="utf-8").splitlines() if line.strip()]

doc = {
    "timestamp_utc": timestamp,
    "container": container,
    "health": (state.get("Health") or {}).get("Status") or "unknown",
    "running": bool(state.get("Running", False)),
    "status": state.get("Status"),
    "started_at": state.get("StartedAt"),
    "restart_count": state.get("RestartCount"),
    "image": config.get("Image"),
    "entrypoint": config.get("Entrypoint"),
    "cmd": config.get("Cmd"),
    "port_bindings": ports,
    "security": {
        "readonly_rootfs": host_cfg.get("ReadonlyRootfs"),
        "cap_drop": host_cfg.get("CapDrop"),
        "security_opt": host_cfg.get("SecurityOpt"),
        "no_new_privileges": "no-new-privileges:true" in (host_cfg.get("SecurityOpt") or []),
    },
    "recent_error_lines": error_lines,
}

out_file.write_text(json.dumps(doc, indent=2), encoding="utf-8")
PY

cp "$out_file" "$latest_file"
rm -f "$error_log_file"

echo "Wrote runtime diagnostics: $out_file"
echo "Updated latest snapshot: $latest_file"
