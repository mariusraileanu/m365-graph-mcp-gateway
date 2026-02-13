#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env}"
CONTAINER_NAME="${2:-openclaw}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Missing required command: openssl" >&2
  exit 1
fi

new_token="$(openssl rand -hex 32)"

tmp_env="$(mktemp)"
cleanup() {
  rm -f "$tmp_env"
}
trap cleanup EXIT

python3 - "$ENV_FILE" "$tmp_env" "$new_token" <<'PY'
import pathlib
import sys

env_path = pathlib.Path(sys.argv[1])
tmp_path = pathlib.Path(sys.argv[2])
token = sys.argv[3]

lines = env_path.read_text(encoding="utf-8").splitlines()
out = []
found = False

for line in lines:
    if line.startswith("OPENCLAW_GATEWAY_AUTH_TOKEN="):
        out.append(f"OPENCLAW_GATEWAY_AUTH_TOKEN={token}")
        found = True
    else:
        out.append(line)

if not found:
    out.append(f"OPENCLAW_GATEWAY_AUTH_TOKEN={token}")

tmp_path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY

cp "$ENV_FILE" "${ENV_FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$tmp_env" "$ENV_FILE"
chmod 600 "$ENV_FILE" || true

echo "Gateway auth token rotated in $ENV_FILE"
echo "Recreating container to apply token..."
docker compose up -d --force-recreate >/dev/null

health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
echo "Container health: ${health:-unknown}"
echo "Rotation complete."
