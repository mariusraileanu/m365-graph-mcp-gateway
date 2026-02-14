#!/usr/bin/env bash
set -euo pipefail

src="${1:-./openclaw.json}"
dst="${2:-./data/.openclaw/openclaw.json}"
fallback_example="./openclaw.json.example"
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
  if [[ "$src" == "./openclaw.json" && -f "$fallback_example" ]]; then
    src="$fallback_example"
    echo "Template ./openclaw.json not found, using: $src"
  elif [[ "$src" == "./openclaw.json" && -f "$fallback_existing" ]]; then
    src="$fallback_existing"
    echo "Template ./openclaw.json not found, using existing runtime config: $src"
  else
    echo "Missing template: $src" >&2
    echo "Pass a template path explicitly, e.g.:" >&2
    echo "  ./scripts/init-config.sh ./openclaw.json.example" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$dst")"
cp "$src" "$dst"
chmod 600 "$dst" || true
echo "Wrote config: $dst"
