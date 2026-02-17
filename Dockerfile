# syntax=docker/dockerfile:1
# =============================================================================
# OpenClaw Docker Image - Multi-stage build
# =============================================================================

# =============================================================================
# Stage 1: Builder - compile dependencies
# =============================================================================
FROM node:22-bookworm AS builder

# Hardcoded versions (update here when changing versions)
ENV OPENCLAW_REF=v2026.2.15
ENV CLAWHUB_VERSION=0.6.1
ENV PNPM_VERSION=10.23.0

RUN echo "Building: OPENCLAW_REF=$OPENCLAW_REF"

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates chromium curl git python3 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:$PATH

RUN git clone https://github.com/openclaw/openclaw.git /opt/openclaw \
    && git -C /opt/openclaw checkout "${OPENCLAW_REF}" \
    && pnpm -C /opt/openclaw install --frozen-lockfile \
    && pnpm -C /opt/openclaw build \
    && pnpm -C /opt/openclaw ui:install \
    && pnpm -C /opt/openclaw ui:build

# =============================================================================
# Stage 2: Skills - install OpenClaw skills (via clawhub)
# =============================================================================
FROM builder AS skills

RUN mkdir -p /home/node/.openclaw/skills \
    && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills tavily-search \
    && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills weather \
    && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills playwright-mcp \
    && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills summarize

# =============================================================================
# Stage 3: Graph MCP Gateway builder
# =============================================================================
FROM builder AS graph-gateway

COPY graph-mcp-gateway/package.json graph-mcp-gateway/package-lock.json graph-mcp-gateway/tsconfig.json /app/graph-mcp-gateway/
COPY graph-mcp-gateway/src /app/graph-mcp-gateway/src
COPY graph-mcp-gateway/config.yaml /app/graph-mcp-gateway/config.yaml

WORKDIR /app/graph-mcp-gateway
RUN npm install && npm run build

# =============================================================================
# Stage 4: Runtime - minimal production image
# =============================================================================
FROM node:22-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    BUN_INSTALL=/root/.bun \
    PNPM_HOME=/opt/pnpm \
    PATH=/home/node/.openclaw/tools/npm-global/bin:/opt/pnpm:/root/.bun/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates chromium curl python3 unzip && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    SIGNAL_CLI_VERSION="$(curl -Ls -o /dev/null -w '%{url_effective}' https://github.com/AsamK/signal-cli/releases/latest | sed -E 's#.*/v##')"; \
    curl -fsSL -o /tmp/signal-cli.tar.gz "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz"; \
    tar -xzf /tmp/signal-cli.tar.gz -C /opt; \
    ln -sf /opt/signal-cli /usr/local/bin/signal-cli; \
    rm -f /tmp/signal-cli.tar.gz; \
    signal-cli --version

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
RUN curl -fsSL https://bun.sh/install | bash
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /opt/openclaw/openclaw.mjs "$@"' > /usr/local/bin/openclaw \
    && chmod +x /usr/local/bin/openclaw

RUN mkdir -p /opt/google/chrome && ln -sf /usr/bin/chromium /opt/google/chrome/chrome

COPY --from=builder /opt/openclaw /opt/openclaw
COPY --from=skills /home/node/.openclaw /home/node/.openclaw
COPY --from=skills /home/node/.openclaw/skills /opt/bundled-skills
COPY --from=skills /home/node/.openclaw/skills/tavily-search /opt/openclaw/skills/tavily-search
COPY --from=skills /home/node/.openclaw/skills/weather /opt/openclaw/skills/weather
COPY --from=skills /home/node/.openclaw/skills/playwright-mcp /opt/openclaw/skills/playwright-mcp
COPY --from=skills /home/node/.openclaw/skills/summarize /opt/openclaw/skills/summarize
COPY templates/skills/tavily-search/SKILL.md /opt/bundled-skills/tavily-search/SKILL.md
COPY templates/skills/tavily-search/SKILL.md /opt/openclaw/skills/tavily-search/SKILL.md
COPY --from=graph-gateway /app/graph-mcp-gateway /app/graph-mcp-gateway

# Patch OpenClaw cron/subagent announce prompts so cron findings are forwarded verbatim
# and duplicate heartbeat cron relays can be suppressed via NO_REPLY.
RUN old1='Summarize this naturally for the user. Keep it brief (1-2 sentences). Flow it into the conversation naturally.' \
    && new1='Forward the Findings section to the user exactly as written. Preserve formatting and wording.' \
    && old2='A scheduled reminder has been triggered. The reminder message is shown in the system messages above. Please relay this reminder to the user in a helpful and friendly way.' \
    && new2='A scheduled reminder has been triggered. The reminder message is shown in the system messages above. If the system message already contains a full cron payload (starts with '"'"'Cron:'"'"'), respond with NO_REPLY to avoid duplicate delivery; otherwise relay the reminder verbatim without paraphrasing.' \
    && for f in /opt/openclaw/dist/*.js /opt/openclaw/src/agents/subagent-announce.ts /opt/openclaw/src/infra/heartbeat-runner.ts; do \
         [ -f "$f" ] || continue; \
         sed -i "s|$old1|$new1|g" "$f"; \
         sed -i "s|$old2|$new2|g" "$f"; \
       done

COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

RUN mkdir -p /home/node/.openclaw /home/node/workspace \
    && chmod -R a+rX /home/node/.openclaw/skills \
    && chmod 700 /home/node/.openclaw \
    && touch /home/node/.openclaw/openclaw.json \
    && chmod 600 /home/node/.openclaw/openclaw.json \
    && chown -R node:node /home/node \
    && mkdir -p /app/graph-mcp-gateway/data/tokens /app/graph-mcp-gateway/data/audit \
    && chown -R node:node /app/graph-mcp-gateway/data

USER node
WORKDIR /home/node

CMD ["/startup.sh"]
