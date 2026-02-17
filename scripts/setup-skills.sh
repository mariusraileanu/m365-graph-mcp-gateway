#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="openclaw"
CLAWHUB_VERSION="${CLAWHUB_VERSION:-0.6.1}"

install_skill() {
  local skill="$1"
  echo "Installing skill: ${skill}"
  docker exec "$CONTAINER_NAME" sh -lc "
    mkdir -p /home/node/.openclaw/skills
    if [ -d /opt/bundled-skills/${skill} ]; then
      rm -rf /home/node/.openclaw/skills/${skill}
      cp -R /opt/bundled-skills/${skill} /home/node/.openclaw/skills/${skill}
    else
      HOME=/tmp/clawhub-home XDG_CONFIG_HOME=/tmp/clawhub-config XDG_CACHE_HOME=/tmp/clawhub-cache \
      npx -y clawhub@${CLAWHUB_VERSION} install --workdir /home/node/.openclaw --dir skills ${skill}
    fi
  "
}

install_skill "tavily-search"
install_skill "weather"
install_skill "playwright-mcp"
install_skill "summarize"

echo "Normalizing Tavily skill instructions to allowlisted wrappers..."
docker exec "$CONTAINER_NAME" sh -lc 'cat > /home/node/.openclaw/skills/tavily-search/SKILL.md <<'"'"'EOF'"'"'
---
name: tavily
description: AI-optimized web search via Tavily API. Returns concise, relevant results for AI agents.
homepage: https://tavily.com
metadata: {"clawdbot":{"emoji":"🔍","requires":{"bins":["tavily-search"],"env":["TAVILY_API_KEY"]},"primaryEnv":"TAVILY_API_KEY"}}
---

# Tavily Search

AI-optimized web search using Tavily API. Designed for AI agents - returns clean, relevant content.

## Search

```bash
tavily-search "query"
tavily-search "query" -n 10
tavily-search "query" --deep
tavily-search "query" --topic news
```

## Options

- `-n <count>`: Number of results (default: 5, max: 20)
- `--deep`: Use advanced search for deeper research (slower, more comprehensive)
- `--topic <topic>`: Search topic - `general` (default) or `news`
- `--days <n>`: For news topic, limit to last n days

## Extract content from URL

```bash
tavily-extract "https://example.com/article"
```

Notes:
- Needs `TAVILY_API_KEY` from https://tavily.com
- Tavily is optimized for AI - returns clean, relevant snippets
- Use `--deep` for complex research questions
- Use `--topic news` for current events
EOF'
echo "Ensuring Playwright MCP runtime binaries..."
docker exec "$CONTAINER_NAME" sh -lc "
  set -e
  mkdir -p /home/node/.openclaw/tools/npm-global /home/node/.openclaw/playwright-browsers
  npm config set prefix /home/node/.openclaw/tools/npm-global
  npm install -g @playwright/mcp
  PLAYWRIGHT_BROWSERS_PATH=/home/node/.openclaw/playwright-browsers npx playwright install chromium
"

echo "Ensuring Summarize CLI runtime binary..."
docker exec "$CONTAINER_NAME" sh -lc "
  set -e
  mkdir -p /home/node/.openclaw/tools/npm-global
  npm config set prefix /home/node/.openclaw/tools/npm-global
  npm install -g @steipete/summarize
"

echo "Removing disallowed skills if present..."
docker exec "$CONTAINER_NAME" sh -lc \
  "rm -rf /home/node/.openclaw/skills/whoop-central /home/node/.openclaw/skills/self-improving-agent || true"

echo "Skills ensured."
