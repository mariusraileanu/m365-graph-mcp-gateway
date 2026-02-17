#!/bin/bash
set -e

export PATH="/home/node/.openclaw/tools/npm-global/bin:${PATH}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/node/.openclaw/playwright-browsers}"

echo "Starting Graph MCP Gateway..."
cd /app/graph-mcp-gateway
node dist/index.js --server &
GATEWAY_PID=$!

echo "Starting OpenClaw..."
node /opt/openclaw/openclaw.mjs gateway run &
OPENCLAW_PID=$!

trap "kill $GATEWAY_PID $OPENCLAW_PID 2>/dev/null" EXIT

wait
