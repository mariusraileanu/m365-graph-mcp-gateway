#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

pattern='(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{20,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}\.[a-zA-Z0-9._-]{10,})'

if rg -n -S --pcre2 "$pattern" . \
  -g 'Dockerfile' \
  -g 'docker-compose.yml' \
  -g 'README.md' \
  -g '.env.example' \
  -g 'openclaw.json.example' \
  -g 'scripts/**/*.sh' \
  -g '.github/workflows/*.yml' \
  -g '.github/dependabot.yml' >/dev/null; then
  echo "Potential hardcoded secret/token detected in source files." >&2
  echo "Run: ./scripts/check/check-secret-leaks.sh to reproduce." >&2
  exit 1
fi

echo "Secret-leak scan passed."
