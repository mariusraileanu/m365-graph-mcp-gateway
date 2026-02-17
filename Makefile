.PHONY: help build up down status logs provision init auth-sync validate deploy test ms365-login graph-login graph-user graph-unread cron-setup skills-setup whatsapp-login whatsapp-pairing-list whatsapp-pairing-approve signal-status signal-link

SHELL := /bin/bash
ROOT_DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

help:
	@echo "OpenClaw - Make Commands"
	@echo "======================="
	@echo "Local:"
	@echo "make build         Build Docker image"
	@echo "make up           Start container"
	@echo "make down         Stop container"
	@echo "make status       Show container status"
	@echo "make logs         Follow container logs"
	@echo "make init         Initialize config (first time)"
	@echo "make provision    Provision and restart"
	@echo "make auth-sync   Sync MS365 + Whoop auth"
	@echo "make graph-login  Authenticate Graph MCP Gateway (M365)"
	@echo "make graph-user   Show authenticated Graph user"
	@echo "make graph-unread Show last 3 unread emails via Graph MCP"
	@echo "make cron-setup   Create/update default cron jobs"
	@echo "make skills-setup Install/refresh default skills in runtime volume"
	@echo "make whatsapp-login Link WhatsApp via QR (default account)"
	@echo "make whatsapp-pairing-list List pending WhatsApp pairing codes"
	@echo "make whatsapp-pairing-approve CODE=<code> Approve pairing request"
	@echo "make signal-status Show Signal channel status"
	@echo "make signal-link [ACCOUNT=+15551234567] Start Signal link flow"
	@echo "make ms365-login  Alias for graph-login (deprecated)"
	@echo "make validate     Validate environment"
	@echo "make test        Local: build + up + wait"
	@echo ""
	@echo "Azure:"
	@echo "make deploy      One-click Azure deploy (RG + VM + bootstrap + provision)"

build:
	@echo "Building OpenClaw..."
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

status:
	docker ps --filter name=openclaw

logs:
	docker logs -f openclaw

init:
	@echo "Initializing config..."
	@if [ ! -f .env ]; then \
		echo "ERROR: .env file not found. Copy .env_example to .env and configure it."; \
		exit 1; \
	fi
	@if [ ! -f data/.openclaw/openclaw.json ]; then \
		mkdir -p data/.openclaw data/workspace data/graph-mcp data/ms365 data/whoop; \
		cp config/openclaw.json.example data/.openclaw/openclaw.json; \
		chmod 600 data/.openclaw/openclaw.json; \
		echo "Config initialized."; \
	else \
		echo "Config already exists."; \
	fi

provision: init
	@echo "Provisioning..."
	@./scripts/provision.sh

auth-sync:
	@echo "Syncing auth..."
	@./scripts/sync-auth.sh

graph-login:
	@echo "=== Graph MCP Login ==="
	@echo "This will start Microsoft authentication for Graph MCP Gateway."
	@echo ""
	@docker exec -it openclaw sh -lc "cd /app/graph-mcp-gateway && node dist/index.js --login"

graph-user:
	@docker exec openclaw sh -lc "cd /app/graph-mcp-gateway && node dist/index.js --user"

graph-unread:
	@docker exec openclaw /home/node/workspace/bin/graph-mcp unread 3

cron-setup:
	@echo "Ensuring default cron jobs..."
	@bash scripts/setup-cron.sh

skills-setup:
	@echo "Ensuring default skills..."
	@bash scripts/setup-skills.sh

whatsapp-login:
	@docker exec -it openclaw node /opt/openclaw/openclaw.mjs channels login --channel whatsapp

whatsapp-pairing-list:
	@docker exec openclaw node /opt/openclaw/openclaw.mjs pairing list whatsapp

whatsapp-pairing-approve:
	@if [ -z "$(CODE)" ]; then \
		echo "Usage: make whatsapp-pairing-approve CODE=<PAIRING_CODE>"; \
		exit 1; \
	fi
	@docker exec openclaw node /opt/openclaw/openclaw.mjs pairing approve whatsapp "$(CODE)"

signal-status:
	@docker exec openclaw node /opt/openclaw/openclaw.mjs channels list

signal-link:
	@if [ -n "$(ACCOUNT)" ]; then \
		docker exec -it openclaw node /opt/openclaw/openclaw.mjs channels login --channel signal --account "$(ACCOUNT)"; \
	else \
		docker exec -it openclaw node /opt/openclaw/openclaw.mjs channels login --channel signal; \
	fi

ms365-login: graph-login

validate:
	@echo "Validating..."
	@./scripts/check/validate-prereqs.sh
	@./scripts/check/validate-env.sh
	@echo "Validation passed."

test: build up
	@echo "Waiting for container to start..."
	@sleep 45
	@echo ""
	@echo "Container logs (last 30 lines):"
	@docker logs openclaw 2>&1 | tail -30
	@echo ""
	@echo "Container status:"
	@docker ps --filter name=openclaw

deploy:
	@bash scripts/deploy-azure-oneclick.sh
