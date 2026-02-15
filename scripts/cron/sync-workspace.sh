#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: sync-workspace.sh [--type main|cron] [target-dir]

Sync workspace template files to target directory.

Options:
  --type main|cron   Workspace type (default: main)
  target-dir         Override target directory

Examples:
  sync-workspace.sh                           # Sync main workspace
  sync-workspace.sh --type cron               # Sync cron workspace
  sync-workspace.sh --type main ./data/workspace
  sync-workspace.sh --type cron ./data/.openclaw/workspace-cron
EOF
}

TYPE="main"
TARGET_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      TYPE="${2:-}"
      [[ "$TYPE" != "main" && "$TYPE" != "cron" ]] && echo "Error: --type must be 'main' or 'cron'" >&2 && exit 1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      TARGET_DIR="$1"
      shift
      ;;
  esac
done

case "$TYPE" in
  main)
    TEMPLATE_DIR="${ROOT_DIR}/templates/workspace"
    TARGET_DIR="${TARGET_DIR:-${ROOT_DIR}/data/workspace}"
    ;;
  cron)
    TEMPLATE_DIR="${ROOT_DIR}/templates/workspace-cron"
    TARGET_DIR="${TARGET_DIR:-${ROOT_DIR}/data/.openclaw/workspace-cron}"
    ;;
esac

mkdir -p "$TARGET_DIR"

for f in AGENTS.md HEARTBEAT.md IDENTITY.md MEMORY.md SOUL.md TOOLS.md USER.md; do
  if [[ -f "${TEMPLATE_DIR}/${f}" ]]; then
    cp "${TEMPLATE_DIR}/${f}" "${TARGET_DIR}/${f}"
  else
    echo "Warning: missing template ${TEMPLATE_DIR}/${f}" >&2
  fi
done

echo "Workspace ($TYPE) synced to: ${TARGET_DIR}"
