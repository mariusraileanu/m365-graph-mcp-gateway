#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: whoop-central <setup|auth|verify|today|summary|recovery|sleep|strain|workouts|import-historical> [args...]" >&2
  exit 2
fi

cmd="$1"
shift
case "$cmd" in
  setup|auth|verify|today|summary|recovery|sleep|strain|workouts|import-historical)
    exec node "${ROOT}/src/${cmd}.js" "$@"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Valid commands: setup auth verify today summary recovery sleep strain workouts import-historical" >&2
    exit 2
    ;;
esac
