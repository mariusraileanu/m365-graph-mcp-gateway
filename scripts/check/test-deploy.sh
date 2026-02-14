#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[1/5] Shell syntax check..."
while IFS= read -r -d '' file; do
  bash -n "$file"
done < <(find scripts -type f -name '*.sh' -print0)

echo "[2/5] Ensure no unpinned latest tags..."
if rg -n '@latest|clawhub@latest' Dockerfile scripts \
  -g '!scripts/test-deploy-scripts.sh' \
  -g '!scripts/check/test-deploy.sh' >/dev/null; then
  echo "Found unpinned @latest usage. Please pin versions before merging." >&2
  exit 1
fi

echo "[3/5] Validate runtime secret placeholders..."
python3 - <<'PY'
import json
import re
import sys
from pathlib import Path

cfg = Path("data/.openclaw/openclaw.json")
if not cfg.exists():
    print("Missing data/.openclaw/openclaw.json", file=sys.stderr)
    sys.exit(1)

obj = json.loads(cfg.read_text(encoding="utf-8"))
placeholder = re.compile(r"^\$\{[A-Z0-9_]+\}$")

def is_placeholder(v):
    return isinstance(v, str) and bool(placeholder.match(v.strip()))

errors = []
providers = ((obj.get("models") or {}).get("providers") or {})
for provider_name, provider_cfg in providers.items():
    api_key = (provider_cfg or {}).get("apiKey")
    if api_key is not None and not is_placeholder(api_key):
        errors.append(f"models.providers.{provider_name}.apiKey")

if errors:
    print("Config contains plaintext secrets in:", file=sys.stderr)
    for e in errors:
        print(f"- {e}", file=sys.stderr)
    sys.exit(1)
PY

echo "[4/5] Verify pinned build args exist in Dockerfile..."
for key in OPENCLAW_REF CLIPPY_REF TAVILY_MCP_VERSION PLAYWRIGHT_MCP_VERSION CLAWHUB_VERSION GOPLACES_VERSION GOPLACES_SHA256_AMD64 GOPLACES_SHA256_ARM64; do
  if ! grep -q "^ARG ${key}=" Dockerfile; then
    echo "Missing pinned Dockerfile arg: ${key}" >&2
    exit 1
  fi
done

echo "[5/5] Secret leak scan..."
./scripts/check/check-secret-leaks.sh

echo "All deployment checks passed."
