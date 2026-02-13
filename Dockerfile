FROM node:22-bookworm

ARG OPENCLAW_REF=dd6047d998b0a3b11f6ed34b3e99d47ca9dd92a0
ARG CLIPPY_REF=8e673e87598594ade431cac818cc00b2ac35b9cc
ARG TAVILY_MCP_VERSION=0.2.17
ARG PLAYWRIGHT_MCP_VERSION=0.0.64
ARG CLAWHUB_VERSION=0.6.1
ARG GOPLACES_VERSION=v0.2.1
ARG GOPLACES_SHA256_AMD64=a03b05b64f8cfcd382dc22c2815a55c2cd7955f63b3507543146607734eac16d
ARG GOPLACES_SHA256_ARM64=dcfcc1cf4fc38ce983f3aca34115bd024fc9e74ffe3432e98e807212e6ad9845
ARG PNPM_VERSION=10.23.0

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    BUN_INSTALL=/opt/bun \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:/opt/bun/bin:/opt/openclaw/node_modules/.bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    curl \
    git \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
RUN npm install -g "tavily-mcp@${TAVILY_MCP_VERSION}" "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"
RUN curl -fsSL https://bun.sh/install | bash && chmod -R a+rx /opt/bun

RUN mkdir -p /opt/openclaw /opt/clippy /home/node/.openclaw /home/node/workspace \
  && chown -R node:node /home/node

RUN git clone https://github.com/openclaw/openclaw.git /opt/openclaw \
  && git -C /opt/openclaw checkout "${OPENCLAW_REF}" \
  && pnpm -C /opt/openclaw install --frozen-lockfile \
  && pnpm -C /opt/openclaw build \
  && pnpm -C /opt/openclaw ui:install \
  && pnpm -C /opt/openclaw ui:build

RUN git clone https://github.com/foeken/clippy.git /opt/clippy \
  && git -C /opt/clippy checkout "${CLIPPY_REF}" \
  && cd /opt/clippy \
  && /opt/bun/bin/bun install

RUN mkdir -p /opt/google/chrome \
  && ln -sf /usr/bin/chromium /opt/google/chrome/chrome

RUN bash -lc 'set -euo pipefail; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) go_arch="amd64"; expected_sha="${GOPLACES_SHA256_AMD64}" ;; \
    arm64) go_arch="arm64"; expected_sha="${GOPLACES_SHA256_ARM64}" ;; \
    *) echo "Unsupported architecture for goplaces: $arch" >&2; exit 1 ;; \
  esac; \
  ver="${GOPLACES_VERSION#v}"; \
  url="https://github.com/steipete/goplaces/releases/download/${GOPLACES_VERSION}/goplaces_${ver}_linux_${go_arch}.tar.gz"; \
  curl -fsSL "$url" -o /tmp/goplaces.tar.gz; \
  actual_sha="$(sha256sum /tmp/goplaces.tar.gz | awk "{print \$1}")"; \
  if [[ "$actual_sha" != "$expected_sha" ]]; then \
    echo "goplaces checksum mismatch for ${go_arch}: expected ${expected_sha}, got ${actual_sha}" >&2; \
    exit 1; \
  fi; \
  tar -xzf /tmp/goplaces.tar.gz -C /tmp; \
  install -m 0755 /tmp/goplaces /usr/local/bin/goplaces; \
  rm -f /tmp/goplaces /tmp/goplaces.tar.gz'

RUN mkdir -p /home/node/.openclaw/skills \
  && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills tavily-search \
  && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills --force whoop-central \
  && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills weather \
  && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills --force goplaces \
  && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills --force self-improving-agent \
  && npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir /home/node/.openclaw --dir skills --force playwright-mcp \
  && mkdir -p /home/node/.openclaw/skills/whoop-central/scripts

COPY scripts/image/openclaw-launcher.sh /usr/local/bin/openclaw
COPY scripts/image/clippy-wrapper.sh /usr/local/bin/clippy
COPY scripts/image/whoop-central-launcher.sh /usr/local/bin/whoop-central
COPY scripts/image/whoop-central-shim.sh /home/node/.openclaw/skills/whoop-central/scripts/whoop-central

RUN chmod 0755 \
      /usr/local/bin/openclaw \
      /usr/local/bin/clippy \
      /usr/local/bin/whoop-central \
      /home/node/.openclaw/skills/whoop-central/scripts/whoop-central \
  && chmod -R a+rX /home/node/.openclaw/skills \
  && chmod 700 /home/node/.openclaw \
  && touch /home/node/.openclaw/openclaw.json \
  && chmod 600 /home/node/.openclaw/openclaw.json \
  && chown -R node:node /opt/openclaw /opt/clippy /home/node

USER node
WORKDIR /home/node

ENTRYPOINT ["openclaw"]
CMD ["gateway", "run"]
