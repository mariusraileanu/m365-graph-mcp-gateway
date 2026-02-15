.PHONY: help build up down status logs provision init auth-sync validate deploy test

SHELL := /bin/bash
ROOT_DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

help:
	@echo "OpenClaw - Make Commands"
	@echo "======================="
	@echo "Local:"
	@echo "make build         Build Docker image"
	@echo "make up            Start container"
	@echo "make down          Stop container"
	@echo "make status        Show container status"
	@echo "make logs          Follow container logs"
	@echo "make init          Initialize config (first time)"
	@echo "make provision     Provision and restart"
	@echo "make auth-sync     Sync Clippy + Whoop auth"
	@echo "make validate      Validate environment"
	@echo "make test          Local: build + up + wait"
	@echo ""
	@echo "Azure:"
	@echo "make deploy        Deploy to Azure VM (1-click)"

build:
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
		mkdir -p data/.openclaw data/workspace data/clippy data/whoop; \
		cp config/openclaw.json_example data/.openclaw/openclaw.json; \
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
	@echo "=== Azure 1-Click Deploy ==="
	@echo ""
	@if ! command -v az >/dev/null 2>&1; then \
		echo "ERROR: Azure CLI (az) not installed."; \
		echo "Install: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"; \
		exit 1; \
	fi
	@echo "Checking Azure login..."
	@az account show >/dev/null 2>&1 || (echo "ERROR: Run 'az login' first" && exit 1)
	@echo ""
	@echo "Creating resource group 'openclaw'..."
	@az group create -n openclaw -l uaenorth --output none 2>/dev/null || true
	@echo "Deploying VM (this may take 2-3 minutes)..."
	@IP=$$(az vm create \
		--resource-group openclaw \
		--name openclaw \
		--image Ubuntu22004 \
		--size Standard_D2s_v3 \
		--admin-user azureuser \
		--ssh-key-value ~/.ssh/id_rsa.pub \
		--custom-data cloud-init.yaml \
		--output tsv --query publicIpAddress); \
	echo ""; \
	echo "========================================"; \
	echo "VM deployed successfully!"; \
	echo "========================================"; \
	echo ""; \
	echo "IP: $$IP"; \
	echo ""; \
	echo "Next steps:"; \
	echo "  1. ssh azureuser@$$IP"; \
	echo "  2. cd /opt/openclaw-docker"; \
	echo "  3. cp .env_example .env && nano .env"; \
	echo "  4. make build && make up && make provision"
