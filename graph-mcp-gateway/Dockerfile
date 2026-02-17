FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY config.yaml ./
COPY data/ ./data/

RUN mkdir -p data/tokens data/audit

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js", "--server"]
