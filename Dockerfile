FROM node:22-bookworm AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY config.yaml ./config.yaml
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config.yaml ./config.yaml

RUN mkdir -p /home/node/m365-graph-mcp-gateway/tokens /home/node/m365-graph-mcp-gateway/audit \
    && chown -R node:node /home/node/m365-graph-mcp-gateway

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV HOME=/home/node

USER node

ENTRYPOINT ["entrypoint.sh"]

EXPOSE 3000

CMD ["node", "dist/index.js"]
