#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

src="${1:-}"
dst="${2:-./data/.openclaw/openclaw.json}"

if [[ -z "$src" ]]; then
  src="${ROOT_DIR}/config/openclaw.json.example"
fi

fallback_existing="./data/.openclaw/openclaw.json"

if [[ -f "$dst" ]]; then
  echo "Config already exists: $dst"
  exit 0
fi

if [[ -d "$dst" ]]; then
  echo "Found directory at config path, replacing with file: $dst"
  rm -rf "$dst"
fi

if [[ ! -f "$src" ]]; then
  if [[ -f "$fallback_existing" ]]; then
    src="$fallback_existing"
    echo "Template not found, using existing runtime config: $src"
  else
    echo "Missing template: $src" >&2
    echo "Pass a template path explicitly, e.g.:" >&2
    echo "  bin/openclawctl init ./config/openclaw.json.example" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$dst")"
cp "$src" "$dst"
chmod 600 "$dst" || true
echo "Wrote config: $dst"
