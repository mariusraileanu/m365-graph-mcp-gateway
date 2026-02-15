# syntax=docker/dockerfile:1
# =============================================================================
# OpenClaw Docker Image - Multi-stage build
# =============================================================================

# =============================================================================
# Stage 1: Builder - compile dependencies
# =============================================================================
FROM node:22-bookworm AS builder

# Hardcoded versions (update here when changing versions)
ENV OPENCLAW_REF=dd6047d998b0a3b11f6ed34b3e99d47ca9dd92a0
ENV CLIPPY_REF=8e673e87598594ade431cac818cc00b2ac35b9cc
ENV TAVILY_MCP_VERSION=0.2.17
ENV PLAYWRIGHT_MCP_VERSION=0.0.64
ENV CLAWHUB_VERSION=0.6.1
ENV PNPM_VERSION=10.23.0

RUN echo "Building: OPENCLAW_REF=$OPENCLAW_REF, CLIPPY_REF=$CLIPPY_REF"

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates chromium curl git python3 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
RUN npm install -g "tavily-mcp@${TAVILY_MCP_VERSION}" "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"
RUN curl -fsSL https://bun.sh/install | bash

RUN git clone https://github.com/openclaw/openclaw.git /opt/openclaw \
    && git -C /opt/openclaw checkout "${OPENCLAW_REF}" \
    && pnpm -C /opt/openclaw install --frozen-lockfile \
    && pnpm -C /opt/openclaw build \
    && pnpm -C /opt/openclaw ui:install \
    && pnpm -C /opt/openclaw ui:build

RUN git clone https://github.com/foeken/clippy.git /opt/clippy \
    && git -C /opt/clippy checkout "${CLIPPY_REF}" \
    && /opt/bun/bin/bun install --cwd /opt/clippy

# =============================================================================
# Stage 2: Skills - install OpenClaw skills (via clawhub)
# =============================================================================
FROM builder AS skills

RUN mkdir -p /home/node/.openclaw/skills \
    && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills \
        tavily-search whoop-central weather goplaces self-improving-agent playwright-mcp \
    && mkdir -p /home/node/.openclaw/skills/whoop-central/scripts

# =============================================================================
# Stage 3: Runtime - minimal production image
# =============================================================================
FROM node:22-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    BUN_INSTALL=/opt/bun \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:/opt/bun/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates chromium curl python3 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
RUN curl -fsSL https://bun.sh/install | bash

RUN mkdir -p /opt/google/chrome && ln -sf /usr/bin/chromium /opt/google/chrome/chrome

COPY --from=builder /opt/openclaw /opt/openclaw
COPY --from=builder /opt/clippy /opt/clippy
COPY --from=skills /home/node/.openclaw /home/node/.openclaw

RUN mkdir -p /home/node/.openclaw /home/node/workspace \
    && chmod -R a+rX /home/node/.openclaw/skills \
    && chmod 700 /home/node/.openclaw \
    && touch /home/node/.openclaw/openclaw.json \
    && chmod 600 /home/node/.openclaw/openclaw.json \
    && chown -R node:node /home/node

USER node
WORKDIR /home/node

CMD ["node", "/opt/openclaw/openclaw.mjs", "gateway", "run"]
