#!/bin/sh
set -e

# ── Bootstrap data directories on the NFS mount ────────────────────────
# The container starts as root so it can create directories on the
# NFS share (owned by root / NoRootSquash).  After mkdir + chown
# we drop to the unprivileged "node" user for the actual process.

if [ -n "$USER_SLUG" ] && [ -d /app/data ]; then
  base="/app/data/${USER_SLUG}/graph-mcp"
  mkdir -p "${base}/tokens" "${base}/audit"
  chown -R node:node "${base}"
fi

exec gosu node "$@"
